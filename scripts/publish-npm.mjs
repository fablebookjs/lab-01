import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  NPM_VERSION,
  PACKAGE_SPECS,
  REGISTRY,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  assertNoTrackedNpmConfiguration,
  assertSafeGitConfiguration,
  assertSha,
  command,
  commitShape,
  createClosedNpmEnvironment,
  fail,
  git,
  packPackages,
  packageEvidence,
  parseSnapshotMessage,
  sanitizedEvidence,
  validateCandidateManifests,
  validateIntentShape,
  validateMergeShape,
  validateSnapshotShape,
} from './release-publication.mjs';

function remoteRef(repoRoot, ref) {
  try {
    const output = git(repoRoot, 'ls-remote', '--exit-code', 'origin', ref);
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) fail(`remote ${ref} is ambiguous`);
    const [sha, observedRef] = rows[0].split(/\s+/);
    assertSha(sha, ref);
    if (observedRef !== ref) fail(`remote returned an unexpected ${ref}`);
    return sha;
  } catch (error) {
    if (error.status === 2) return null;
    throw error;
  }
}

function repositoryMatches(repository, directory) {
  return repository?.type === 'git' && repository.url === REPOSITORY_URL && repository.directory === directory;
}

async function fetchRegistryPackage(spec) {
  const metadataUrl = new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, REGISTRY);
  const response = await fetch(metadataUrl, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return { status: 'absent', name: spec.name };
  if (!response.ok) fail(`registry query for ${spec.name} failed with ${response.status}`);
  const metadata = await response.json();
  if (
    metadata.name !== spec.name ||
    metadata.version !== RELEASE_VERSION ||
    !repositoryMatches(metadata.repository, spec.directory) ||
    typeof metadata.dist?.integrity !== 'string' ||
    typeof metadata.dist?.shasum !== 'string' ||
    typeof metadata.dist?.tarball !== 'string'
  ) fail(`PERMANENT STOP: registry metadata for ${spec.name} is incompatible`);
  const tarballUrl = new URL(metadata.dist.tarball);
  const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
  const expectedTarball = new URL(`/${spec.name}/-/${archiveName}`, REGISTRY);
  if (tarballUrl.href !== expectedTarball.href) fail(`PERMANENT STOP: registry tarball for ${spec.name} has an incompatible URL`);
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) fail(`registry tarball for ${spec.name} failed with ${tarballResponse.status}`);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (integrity !== metadata.dist.integrity || shasum !== metadata.dist.shasum) {
    fail(`registry tarball for ${spec.name} does not match its metadata`);
  }
  return {
    status: 'present',
    name: spec.name,
    version: metadata.version,
    repository: metadata.repository,
    integrity,
    shasum,
    tarball: tarballUrl.href,
  };
}

export const liveNpmAdapter = {
  query: fetchRegistryPackage,
  async publish(artifact, env) {
    await command(
      'npm',
      [
        'publish', artifact.tarball,
        '--access', 'public',
        '--ignore-scripts',
        '--provenance',
        '--registry', REGISTRY,
      ],
      { cwd: join(artifact.tarball, '..'), env },
    );
  },
};

function assertMatching(observation, artifact) {
  if (observation.status !== 'present') fail(`${artifact.name}@${RELEASE_VERSION} is absent`);
  if (observation.integrity !== artifact.integrity || observation.shasum !== artifact.shasum) {
    fail(`PERMANENT STOP: npm ${artifact.name}@${RELEASE_VERSION} does not match V`);
  }
  const spec = PACKAGE_SPECS.find(({ name }) => name === artifact.name);
  if (!repositoryMatches(observation.repository, spec.directory)) {
    fail(`PERMANENT STOP: npm ${artifact.name}@${RELEASE_VERSION} has an incompatible repository`);
  }
}

export async function applyPublicationState({ choice, artifacts, adapter, npmEnvironment }) {
  const selectedIndex = PACKAGE_SPECS.findIndex((spec) => spec.choice === choice);
  if (selectedIndex < 0) fail('package choice must be exactly core or addon');
  const observations = [];
  for (let index = 0; index < PACKAGE_SPECS.length; index += 1) {
    const observation = await adapter.query(PACKAGE_SPECS[index]);
    observations.push(observation);
    if (observation.status === 'present') assertMatching(observation, artifacts[index]);
  }
  if (observations[0].status === 'absent' && observations[1].status === 'present') {
    fail('PERMANENT STOP: add-on exists while required core is absent');
  }
  if (choice === 'addon' && observations[0].status !== 'present') {
    fail('add-on publication is blocked until exact matching core 1.0.1 is public');
  }

  const before = observations[selectedIndex];
  if (before.status === 'present') {
    return { result: 'reused', before, after: before, observations };
  }
  try {
    await adapter.publish(artifacts[selectedIndex], npmEnvironment);
  } catch (error) {
    const raced = await adapter.query(PACKAGE_SPECS[selectedIndex]);
    if (raced.status === 'present') {
      assertMatching(raced, artifacts[selectedIndex]);
      return { result: 'published-after-ambiguous-response', before, after: raced, observations };
    }
    throw new Error(`publication stopped at ${artifacts[selectedIndex].name}: ${error.message}`, { cause: error });
  }
  const after = await adapter.query(PACKAGE_SPECS[selectedIndex]);
  assertMatching(after, artifacts[selectedIndex]);
  return { result: 'published-and-verified', before, after, observations };
}

function assertAncestor(repoRoot, ancestor, descendant, message) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    fail(message);
  }
}

export async function publishFromSnapshot({
  repoRoot,
  choice,
  evidencePath,
  npmAdapter = liveNpmAdapter,
  refAdapter = remoteRef,
  temporaryBase = tmpdir(),
  oidc = true,
}) {
  assertSafeGitConfiguration(repoRoot);
  if (git(repoRoot, 'status', '--porcelain') !== '') fail('publisher requires a clean checkout');
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) fail('traditional npm credentials are prohibited');
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  if (npmVersion !== NPM_VERSION) fail(`publisher requires npm ${NPM_VERSION}, observed ${npmVersion}`);

  const snapshotSha = await refAdapter(repoRoot, SNAPSHOT_REF);
  const lineHead = await refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
  assertSha(snapshotSha, 'snapshot ref');
  assertSha(lineHead, 'release line');
  const snapshot = commitShape(repoRoot, snapshotSha);
  const metadata = parseSnapshotMessage(snapshot.message);
  assertSha(metadata.mergeSha, 'snapshot M');
  assertSha(metadata.stagedSha, 'snapshot staged SHA');
  assertSha(metadata.sourceSha, 'snapshot source SHA');
  const merge = commitShape(repoRoot, metadata.mergeSha);
  const source = commitShape(repoRoot, metadata.sourceSha);
  const intent = commitShape(repoRoot, metadata.stagedSha);
  intent.sourceTree = source.tree;
  validateIntentShape(intent, source.sha);
  validateMergeShape(merge, source, intent);
  validateSnapshotShape(snapshot, metadata, merge);
  assertAncestor(repoRoot, merge.sha, lineHead, 'release line does not contain sealed M');
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', snapshot.sha, lineHead], { cwd: repoRoot, stdio: 'ignore' });
    fail('release line was reconciled to V before npm publication completed');
  } catch (error) {
    if (error.message.startsWith('release line was reconciled')) throw error;
  }
  assertNoTrackedNpmConfiguration(repoRoot, snapshot.sha);

  const temporary = await mkdtemp(join(temporaryBase, 'lab-01-publish-'));
  const candidate = join(temporary, 'candidate');
  let worktreeAdded = false;
  try {
    git(repoRoot, 'worktree', 'add', '--detach', candidate, snapshot.sha);
    worktreeAdded = true;
    await validateCandidateManifests(candidate);
    if (git(candidate, 'status', '--porcelain') !== '') fail('V checkout is not clean');
    const npmEnvironment = await createClosedNpmEnvironment(join(temporary, 'npm'), { oidc });
    const packed = await packPackages(candidate, join(temporary, 'packs'), npmEnvironment);
    const identities = packageEvidence(packed);
    const reduced = identities.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
    if (JSON.stringify(reduced) !== JSON.stringify(metadata.packages)) fail('packed V tarballs do not equal snapshot metadata');
    const publication = await applyPublicationState({ choice, artifacts: packed, adapter: npmAdapter, npmEnvironment });
    const lineAfter = await refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
    if (lineAfter !== lineHead) fail('release line changed during npm publication');
    const evidence = sanitizedEvidence({
      schemaVersion: 1,
      operation: 'publish-npm',
      repository: REPOSITORY,
      choice,
      release: { line: RELEASE_LINE, version: RELEASE_VERSION, sourceSha: source.sha, stagedSha: intent.sha, mergeSha: merge.sha },
      qa: { runId: Number(metadata.qaRunId) },
      snapshot: { ref: SNAPSHOT_REF, sha: snapshot.sha, tree: snapshot.tree, parent: merge.sha, packages: identities },
      npm: publication,
      safety: { releaseLineBefore: lineHead, releaseLineAfter: lineAfter, tagMutation: false, githubReleaseMutation: false, reconciliationMutation: false, traditionalToken: false },
    });
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    if (worktreeAdded) {
      try { git(repoRoot, 'worktree', 'remove', '--force', candidate); } catch { /* best-effort cleanup */ }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail('publisher arguments must be --key value pairs');
    values[key.slice(2)] = value;
  }
  for (const key of ['repository', 'package', 'evidence']) if (!values[key]) fail(`missing --${key}`);
  if (values.repository !== REPOSITORY) fail(`refusing publication outside ${REPOSITORY}`);
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArguments(process.argv.slice(2));
  publishFromSnapshot({
    repoRoot: git(process.cwd(), 'rev-parse', '--show-toplevel'),
    choice: args.package,
    evidencePath: args.evidence,
  }).then((evidence) => console.log(JSON.stringify(evidence))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
