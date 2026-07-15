import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  PACKAGE_SPECS,
  REGISTRY,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  assertNoTrackedNpmConfiguration,
  assertPinnedNpmVersion,
  assertSafeGitConfiguration,
  assertSha,
  closedGitEnvironment,
  command,
  commitShape,
  fail,
  git,
  materializeInertPackages,
  packPackages,
  packageEvidence,
  parseSnapshotMessage,
  reconstructExpectedSnapshot,
  sanitizedEvidence,
  validateExactSnapshotTree,
  validateIntentShape,
  validateMergeShape,
  validateSnapshotShape,
} from './release-publication.mjs';

function remoteRef(repoRoot, ref) {
  try {
    const output = execFileSync('git', ['--no-replace-objects', 'ls-remote', '--refs', '--exit-code', 'origin', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: closedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) fail('REMOTE_REF_AMBIGUOUS');
    const [sha, observedRef] = rows[0].split(/\s+/);
    assertSha(sha, 'remote ref');
    if (observedRef !== ref) fail('REMOTE_REF_IDENTITY_INVALID');
    return sha;
  } catch (error) {
    if (error.status === 2) return null;
    fail('REMOTE_REF_READ_FAILED');
  }
}

function fetchObjects(repoRoot, shas) {
  try {
    execFileSync('git', ['--no-replace-objects', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...shas], {
      cwd: repoRoot,
      env: closedGitEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    fail('RELEASE_OBJECT_FETCH_FAILED');
  }
}

function repositoryMatches(repository, directory) {
  return repository?.type === 'git' && repository.url === REPOSITORY_URL && repository.directory === directory;
}

async function fetchRegistryPackage(spec) {
  let response;
  try {
    response = await fetch(new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, REGISTRY), { headers: { Accept: 'application/json' } });
  } catch { fail(`NPM_QUERY_FAILED_${spec.choice.toUpperCase()}`); }
  if (response.status === 404) return { status: 'absent', name: spec.name };
  if (!response.ok) fail(`NPM_QUERY_FAILED_${spec.choice.toUpperCase()}`);
  let metadata;
  try { metadata = await response.json(); } catch { fail(`NPM_METADATA_INVALID_${spec.choice.toUpperCase()}`); }
  if (
    metadata.name !== spec.name || metadata.version !== RELEASE_VERSION ||
    !repositoryMatches(metadata.repository, spec.directory) ||
    typeof metadata.dist?.integrity !== 'string' || typeof metadata.dist?.shasum !== 'string' || typeof metadata.dist?.tarball !== 'string'
  ) fail(`NPM_METADATA_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
  const expectedTarball = new URL(`/${spec.name}/-/${archiveName}`, REGISTRY);
  if (metadata.dist.tarball !== expectedTarball.href) fail(`NPM_TARBALL_URL_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  let tarballResponse;
  try { tarballResponse = await fetch(expectedTarball); } catch { fail(`NPM_TARBALL_READ_FAILED_${spec.choice.toUpperCase()}`); }
  if (!tarballResponse.ok) fail(`NPM_TARBALL_READ_FAILED_${spec.choice.toUpperCase()}`);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (integrity !== metadata.dist.integrity || shasum !== metadata.dist.shasum) fail(`NPM_TARBALL_BYTES_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  return { status: 'present', name: spec.name, version: metadata.version, repository: metadata.repository, integrity, shasum, tarball: expectedTarball.href };
}

export const liveNpmAdapter = {
  query: fetchRegistryPackage,
  async publish(artifact, env, neutralDirectory) {
    await command('npm', [
      'publish', artifact.tarball, '--access', 'public', '--ignore-scripts', '--provenance', '--registry', REGISTRY,
    ], { cwd: neutralDirectory, env, errorCode: `NPM_PUBLISH_FAILED_${artifact.choice.toUpperCase()}` });
  },
};

function assertMatching(observation, artifact) {
  if (observation.status !== 'present') fail(`NPM_EXPECTED_PRESENT_${artifact.choice.toUpperCase()}`);
  if (observation.integrity !== artifact.integrity || observation.shasum !== artifact.shasum) fail(`NPM_INTEGRITY_INCOMPATIBLE_${artifact.choice.toUpperCase()}`);
  if (!repositoryMatches(observation.repository, artifact.directory)) fail(`NPM_REPOSITORY_INCOMPATIBLE_${artifact.choice.toUpperCase()}`);
}

export async function applyPublicationState({ choice, artifacts, adapter, npmEnvironment, neutralDirectory = tmpdir() }) {
  const selectedIndex = PACKAGE_SPECS.findIndex((spec) => spec.choice === choice);
  if (selectedIndex < 0) fail('PACKAGE_CHOICE_INVALID');
  const observations = [];
  for (let index = 0; index < PACKAGE_SPECS.length; index += 1) {
    const observation = await adapter.query(PACKAGE_SPECS[index]);
    observations.push(observation);
    if (observation.status === 'present') assertMatching(observation, artifacts[index]);
  }
  if (observations[0].status === 'absent' && observations[1].status === 'present') fail('NPM_INVERSE_PARTIAL_STATE');
  if (choice === 'addon' && observations[0].status !== 'present') fail('ADDON_BLOCKED_UNTIL_CORE');
  const before = observations[selectedIndex];
  if (before.status === 'present') return { result: 'reused', before, after: before, observations };
  try {
    await adapter.publish(artifacts[selectedIndex], npmEnvironment, neutralDirectory);
  } catch (error) {
    const raced = await adapter.query(PACKAGE_SPECS[selectedIndex]);
    if (raced.status === 'present') {
      assertMatching(raced, artifacts[selectedIndex]);
      return { result: 'published-after-ambiguous-response', before, after: raced, observations };
    }
    throw error;
  }
  const after = await adapter.query(PACKAGE_SPECS[selectedIndex]);
  assertMatching(after, artifacts[selectedIndex]);
  return { result: 'published-and-verified', before, after, observations };
}

function assertAncestor(repoRoot, ancestor, descendant, code) {
  try { execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot, env: closedGitEnvironment(), stdio: 'ignore' }); }
  catch { fail(code); }
}

export function lineRelation(repoRoot, mergeSha, snapshotSha, lineHead) {
  assertAncestor(repoRoot, mergeSha, lineHead, 'RELEASE_LINE_DOES_NOT_CONTAIN_M');
  try {
    execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', snapshotSha, lineHead], { cwd: repoRoot, env: closedGitEnvironment(), stdio: 'ignore' });
    fail('RELEASE_LINE_RECONCILED_BEFORE_PUBLICATION');
  } catch (error) {
    if (error.code === 'RELEASE_LINE_RECONCILED_BEFORE_PUBLICATION') throw error;
  }
  return lineHead === mergeSha ? 'at-merge' : 'late-descendant';
}

async function durableNpmState(adapter) {
  const state = [];
  for (const spec of PACKAGE_SPECS) {
    try {
      const item = await adapter.query(spec);
      state.push(item.status === 'present'
        ? { name: spec.name, status: 'present', integrity: item.integrity, shasum: item.shasum, repository: item.repository }
        : { name: spec.name, status: 'absent' });
    } catch (error) {
      state.push({ name: spec.name, status: 'unknown', code: error.code ?? 'NPM_STATE_READ_FAILED' });
    }
  }
  return state;
}

export function assertTrustedMain(repoRoot, refAdapter) {
  const local = git(repoRoot, 'rev-parse', 'HEAD');
  const remote = refAdapter(repoRoot, 'refs/heads/main');
  const dispatch = process.env.EXPECTED_DISPATCH_SHA;
  const workflow = process.env.EXPECTED_WORKFLOW_SHA;
  if (local !== remote || dispatch !== remote || workflow !== remote || process.env.GITHUB_REF !== 'refs/heads/main') {
    fail('TRUSTED_MAIN_IDENTITY_MISMATCH');
  }
  return remote;
}

export async function publishFromSnapshot({
  repoRoot,
  choice,
  evidencePath,
  npmAdapter = liveNpmAdapter,
  refAdapter = remoteRef,
  fetchAdapter = fetchObjects,
  temporaryBase = tmpdir(),
  oidc = true,
}) {
  const evidence = {
    schemaVersion: 2,
    operation: 'publish-npm',
    repository: REPOSITORY,
    choice,
    status: 'started',
    npm: { durable: [] },
    error: null,
    safety: { trustedMain: null, candidateExecuted: false, traditionalToken: false, reconciliationMutation: false, tagMutation: false, githubReleaseMutation: false },
  };
  let temporary;
  let thrown;
  try {
    assertSafeGitConfiguration(repoRoot);
    if (git(repoRoot, 'status', '--porcelain') !== '') fail('PUBLISHER_WORKTREE_DIRTY');
    if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) fail('TRADITIONAL_NPM_TOKEN_PROHIBITED');
    evidence.safety.trustedMain = assertTrustedMain(repoRoot, refAdapter);
    temporary = await mkdtemp(join(temporaryBase, 'lab-01-publish-'));
    const npmEnvironment = await assertPinnedNpmVersion(join(temporary, 'npm'), { oidc });
    const snapshotSha = refAdapter(repoRoot, SNAPSHOT_REF);
    const lineBefore = refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
    assertSha(snapshotSha, 'snapshot ref');
    assertSha(lineBefore, 'release line');
    fetchAdapter(repoRoot, [snapshotSha, lineBefore]);
    const snapshotMessage = commitShape(repoRoot, snapshotSha).message;
    const metadata = parseSnapshotMessage(snapshotMessage);
    fetchAdapter(repoRoot, [metadata.mergeSha, metadata.stagedSha, metadata.sourceSha]);
    const merge = commitShape(repoRoot, metadata.mergeSha);
    const source = commitShape(repoRoot, metadata.sourceSha);
    const intent = commitShape(repoRoot, metadata.stagedSha);
    intent.sourceTree = source.tree;
    validateIntentShape(intent, source.sha);
    validateMergeShape(merge, source, intent);
    assertNoTrackedNpmConfiguration(repoRoot, merge.sha);
    const expected = reconstructExpectedSnapshot(repoRoot, merge.sha, join(temporary, 'index'));
    const snapshot = validateExactSnapshotTree(repoRoot, merge.sha, snapshotSha, expected.tree);
    validateSnapshotShape(snapshot, metadata, merge);
    if (metadata.contentSha256 !== expected.contentSha256) fail('SNAPSHOT_CONTENT_CROSSCHECK_FAILED');
    evidence.release = { line: RELEASE_LINE, version: RELEASE_VERSION, sourceSha: source.sha, stagedSha: intent.sha, mergeSha: merge.sha };
    evidence.snapshot = { ref: SNAPSHOT_REF, sha: snapshot.sha, tree: expected.tree, parent: merge.sha };
    evidence.line = { before: lineBefore, beforeRelation: lineRelation(repoRoot, merge.sha, snapshot.sha, lineBefore), after: null, afterRelation: null };
    const inert = join(temporary, 'inert');
    await materializeInertPackages(repoRoot, expected.tree, inert);
    const packed = await packPackages(inert, join(temporary, 'packs'), npmEnvironment);
    const identities = packageEvidence(packed);
    const reduced = identities.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
    if (JSON.stringify(reduced) !== JSON.stringify(metadata.packages)) fail('SNAPSHOT_MESSAGE_HASH_CROSSCHECK_FAILED');
    evidence.snapshot.packages = identities;
    evidence.npm.publication = await applyPublicationState({ choice, artifacts: packed, adapter: npmAdapter, npmEnvironment, neutralDirectory: temporary });
    const lineAfter = refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
    fetchAdapter(repoRoot, [lineAfter]);
    evidence.line.after = lineAfter;
    evidence.line.afterRelation = lineRelation(repoRoot, merge.sha, snapshot.sha, lineAfter);
    evidence.status = 'succeeded';
  } catch (error) {
    thrown = error;
    evidence.status = 'failed';
    evidence.error = { code: error.code ?? 'PUBLISHER_FAILED' };
  } finally {
    evidence.npm.durable = await durableNpmState(npmAdapter);
    try {
      if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(sanitizedEvidence(evidence), null, 2)}\n`);
    } catch {
      try { fail('EVIDENCE_WRITE_FAILED'); } catch (error) { thrown ??= error; }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  if (thrown) throw thrown;
  return evidence;
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined) fail('PUBLISHER_ARGUMENTS_INVALID');
    values[args[index].slice(2)] = args[index + 1];
  }
  for (const key of ['repository', 'package', 'evidence']) if (!values[key]) fail('PUBLISHER_ARGUMENTS_INVALID');
  if (values.repository !== REPOSITORY) fail('PUBLISHER_REPOSITORY_INVALID');
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArguments(process.argv.slice(2));
  const interrupted = (signal) => {
    try {
      writeFileSync(args.evidence, `${JSON.stringify({ schemaVersion: 2, operation: 'publish-npm', repository: REPOSITORY, choice: args.package, status: 'interrupted', error: { code: signal }, npm: { durable: [{ status: 'unknown' }] } }, null, 2)}\n`);
    } finally { process.exit(1); }
  };
  process.once('SIGINT', () => interrupted('SIGINT'));
  process.once('SIGTERM', () => interrupted('SIGTERM'));
  publishFromSnapshot({ repoRoot: git(process.cwd(), 'rev-parse', '--show-toplevel'), choice: args.package, evidencePath: args.evidence })
    .then((evidence) => console.log(JSON.stringify({ status: evidence.status, choice: evidence.choice })))
    .catch((error) => { console.error(error.code ?? 'PUBLISHER_FAILED'); process.exitCode = 1; });
}
