import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { transformCandidate } from './qa-ready-release.mjs';
import {
  NPM_VERSION,
  PACKAGE_SPECS,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  SNAPSHOT_REF,
  STAGED_LINE,
  TRANSFORMED_FILES,
  assertNoTrackedNpmConfiguration,
  assertSafeGitConfiguration,
  assertSha,
  buildSnapshotMessage,
  commitShape,
  createClosedNpmEnvironment,
  fail,
  git,
  packPackages,
  packageEvidence,
  parseSnapshotMessage,
  readJson,
  sanitizedEvidence,
  validateCandidateManifests,
  validateIntentShape,
  validateMergeShape,
  validateSnapshotShape,
  validateQaEvidence,
} from './release-publication.mjs';

const PR_NUMBER = /^[1-9]\d*$/;

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is required for read-only GitHub authority');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubGet(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders() });
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`GitHub GET ${path} failed with ${response.status}`);
  return body;
}

function remoteRef(repoRoot, fullRef) {
  try {
    const output = git(repoRoot, 'ls-remote', '--exit-code', 'origin', fullRef);
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) fail(`remote ${fullRef} is ambiguous`);
    const [sha, ref] = rows[0].split(/\s+/);
    assertSha(sha, fullRef);
    if (ref !== fullRef) fail(`remote returned an unexpected ref for ${fullRef}`);
    return sha;
  } catch (error) {
    if (/exit code 2|status 2|exit status 2/.test(error.message)) return null;
    if (error.status === 2) return null;
    throw error;
  }
}

export const liveAdapter = {
  pull: (number) => githubGet(`/repos/${REPOSITORY}/pulls/${number}`),
  releasePulls: () => githubGet(`/repos/${REPOSITORY}/pulls?state=all&base=${encodeURIComponent(RELEASE_LINE)}&head=fablebookjs%3A${encodeURIComponent(STAGED_LINE)}&per_page=100`),
  run: (id) => githubGet(`/repos/${REPOSITORY}/actions/runs/${id}`),
  artifacts: (id) => githubGet(`/repos/${REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`),
  ref: (repoRoot, ref) => remoteRef(repoRoot, ref),
  pushSnapshot(repoRoot, sha) {
    execFileSync(
      'git',
      ['push', '--porcelain', `--force-with-lease=${SNAPSHOT_REF}:`, 'origin', `${sha}:${SNAPSHOT_REF}`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  },
};

export function validateMergedAuthority({ pull, pulls, run, artifacts, prNumber, qaRunId }) {
  if (
    pull?.number !== Number(prNumber) ||
    pull.state !== 'closed' ||
    pull.merged !== true ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    pull.base.ref !== RELEASE_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY ||
    pull.head.ref !== STAGED_LINE
  ) {
    fail('release PR is not the exact merged same-repository staging proposal');
  }
  const stagedSha = pull.head.sha;
  const mergeSha = pull.merge_commit_sha;
  for (const [value, label] of [[stagedSha, 'PR staged head'], [mergeSha, 'PR merge']]) {
    assertSha(value, label);
  }
  if (
    run?.id !== Number(qaRunId) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/ready-release-qa.yml' ||
    run.head_sha !== stagedSha ||
    !['pull_request', 'workflow_dispatch'].includes(run.event)
  ) {
    fail('specified QA run is not the successful exact staged-head workflow');
  }
  const expectedName = `ready-release-qa-${stagedSha}`;
  const matching = artifacts?.artifacts?.filter((artifact) => artifact.name === expectedName && !artifact.expired) ?? [];
  if (matching.length !== 1 || artifacts.total_count !== 1) fail('QA run does not contain exactly one unexpired expected artifact');
  const matchingPulls = pulls?.filter((candidate) =>
    candidate.number === pull.number &&
    (candidate.merged === true || typeof candidate.merged_at === 'string') &&
    candidate.merge_commit_sha === mergeSha &&
    candidate.head?.sha === stagedSha &&
    candidate.base?.ref === RELEASE_LINE &&
    candidate.head?.ref === STAGED_LINE
  ) ?? [];
  if (matchingPulls.length !== 1) fail('merged release PR authority is missing or ambiguous');
  return { stagedSha, mergeSha, artifact: matching[0] };
}

export async function ensureSnapshotRef({ adapter, repoRoot, snapshotSha }) {
  const existing = await adapter.ref(repoRoot, SNAPSHOT_REF);
  if (existing === snapshotSha) return 'reused';
  if (existing !== null) fail(`existing ${SNAPSHOT_REF} is incompatible with deterministic V`);
  let result = 'created';
  try {
    await adapter.pushSnapshot(repoRoot, snapshotSha);
  } catch (error) {
    const raced = await adapter.ref(repoRoot, SNAPSHOT_REF);
    if (raced !== snapshotSha) throw error;
    result = 'created-after-ambiguous-response';
  }
  const observed = await adapter.ref(repoRoot, SNAPSHOT_REF);
  if (observed !== snapshotSha) fail('snapshot ref write was not visible at exact V');
  return result;
}

async function transformedContentIdentity(candidateDirectory) {
  const hash = createHash('sha256');
  for (const path of TRANSFORMED_FILES) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(join(candidateDirectory, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createSnapshotCommit(repoRoot, tree, mergeSha, message) {
  return execFileSync('git', ['commit-tree', tree, '-p', mergeSha], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  }).trim();
}

function samePackages(left, right) {
  return JSON.stringify(left.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }))) ===
    JSON.stringify(right.map(({ name, integrity, shasum }) => ({ name, integrity, shasum })));
}

export async function prepareReleaseSnapshot({
  repoRoot,
  prNumber,
  qaRunId,
  qaEvidencePath,
  evidencePath,
  adapter = liveAdapter,
  temporaryBase = tmpdir(),
}) {
  if (!PR_NUMBER.test(String(prNumber)) || !PR_NUMBER.test(String(qaRunId))) fail('PR number and QA run ID must be positive decimals');
  assertSafeGitConfiguration(repoRoot);
  if (git(repoRoot, 'status', '--porcelain') !== '') fail('snapshot preparation requires a clean worktree');
  const npmVersion = (await import('node:child_process')).execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  if (npmVersion !== NPM_VERSION) fail(`snapshot preparation requires npm ${NPM_VERSION}, observed ${npmVersion}`);

  const [pull, pulls, run, artifacts] = await Promise.all([
    adapter.pull(prNumber), adapter.releasePulls(), adapter.run(qaRunId), adapter.artifacts(qaRunId),
  ]);
  const authority = validateMergedAuthority({ pull, pulls, run, artifacts, prNumber, qaRunId });
  const lineBefore = await adapter.ref(repoRoot, `refs/heads/${RELEASE_LINE}`);
  assertSha(lineBefore, 'release line');

  const merge = commitShape(repoRoot, authority.mergeSha);
  if (merge.parents.length !== 2 || merge.parents[1] !== authority.stagedSha) {
    fail('M does not have the PR staged head as its exact second parent');
  }
  const source = commitShape(repoRoot, merge.parents[0]);
  const intent = commitShape(repoRoot, merge.parents[1]);
  intent.sourceTree = source.tree;
  validateIntentShape(intent, source.sha);
  validateMergeShape(merge, source, intent);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', merge.sha, lineBefore], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    fail('release line does not contain sealed merge M');
  }
  assertNoTrackedNpmConfiguration(repoRoot, merge.sha);

  const rawQaEvidence = await readJson(qaEvidencePath);
  const qa = validateQaEvidence(rawQaEvidence, {
    stagedSha: intent.sha,
    sourceSha: source.sha,
    qaRunId,
    prNumber,
  });
  if (qa.sourceTree !== source.tree) fail('QA source tree does not equal sealed source tree');

  const temporary = await mkdtemp(join(temporaryBase, 'lab-01-snapshot-'));
  const candidate = join(temporary, 'candidate');
  let worktreeAdded = false;
  try {
    git(repoRoot, 'worktree', 'add', '--detach', candidate, merge.sha);
    worktreeAdded = true;
    await transformCandidate(candidate);
    await validateCandidateManifests(candidate);
    const changed = git(candidate, 'diff', '--name-only').split('\n').filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify(TRANSFORMED_FILES)) fail('version transform changed files outside the exact allowlist');
    git(candidate, 'add', '--', ...TRANSFORMED_FILES);
    const tree = git(candidate, 'write-tree');
    if (tree !== qa.transformedTree) fail('reproduced transformed tree does not equal QA tree');
    const contentSha256 = await transformedContentIdentity(candidate);
    if (contentSha256 !== qa.transformedContentSha256) fail('reproduced transformed content hash does not equal QA evidence');
    const npmEnvironment = await createClosedNpmEnvironment(join(temporary, 'npm'));
    const packed = await packPackages(candidate, join(temporary, 'packs'), npmEnvironment);
    const packages = packageEvidence(packed);
    if (!samePackages(packages, qa.packages)) fail('reproduced tarball identities do not equal QA evidence');

    const message = buildSnapshotMessage({
      mergeSha: merge.sha,
      qaRunId,
      stagedSha: intent.sha,
      sourceSha: source.sha,
      packages,
    });
    const snapshotSha = createSnapshotCommit(repoRoot, tree, merge.sha, message);
    assertSha(snapshotSha, 'snapshot V');
    const snapshot = commitShape(repoRoot, snapshotSha);
    const metadata = parseSnapshotMessage(snapshot.message);
    validateSnapshotShape(snapshot, metadata, merge);
    if (snapshot.parents.length !== 1 || snapshot.parents[0] !== merge.sha || snapshot.tree !== tree || !samePackages(metadata.packages, packages)) {
      fail('created V does not match its deterministic release contract');
    }

    const result = await ensureSnapshotRef({ adapter, repoRoot, snapshotSha });
    const lineAfter = await adapter.ref(repoRoot, `refs/heads/${RELEASE_LINE}`);
    if (lineAfter !== lineBefore) fail('release line changed during snapshot preparation');

    const evidence = sanitizedEvidence({
      schemaVersion: 1,
      operation: 'prepare-release-snapshot',
      repository: REPOSITORY,
      release: { line: RELEASE_LINE, version: RELEASE_VERSION, sourceSha: source.sha, stagedSha: intent.sha, mergeSha: merge.sha },
      qa: { runId: Number(qaRunId), artifactId: authority.artifact.id, transformedTree: tree, transformedContentSha256: contentSha256 },
      snapshot: { ref: SNAPSHOT_REF, sha: snapshotSha, parent: merge.sha, tree, result, packages },
      safety: { releaseLineBefore: lineBefore, releaseLineAfter: lineAfter, npmMutation: false, tagMutation: false, githubReleaseMutation: false },
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
    if (!key?.startsWith('--') || value === undefined) fail('snapshot arguments must be --key value pairs');
    values[key.slice(2)] = value;
  }
  for (const key of ['repository', 'release-pr', 'qa-run', 'qa-evidence', 'evidence']) {
    if (!values[key]) fail(`missing --${key}`);
  }
  if (values.repository !== REPOSITORY) fail(`refusing snapshot preparation outside ${REPOSITORY}`);
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArguments(process.argv.slice(2));
  prepareReleaseSnapshot({
    repoRoot: git(process.cwd(), 'rev-parse', '--show-toplevel'),
    prNumber: args['release-pr'],
    qaRunId: args['qa-run'],
    qaEvidencePath: args['qa-evidence'],
    evidencePath: args.evidence,
  }).then((evidence) => console.log(JSON.stringify(evidence))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
