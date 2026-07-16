import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { localAuthority, runReadyReleaseQa } from './qa-ready-release.mjs';
import {
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  SNAPSHOT_REF,
  STAGED_LINE,
  assertNoTrackedNpmConfiguration,
  assertPinnedNpmVersion,
  assertSafeGitConfiguration,
  assertSha,
  buildSnapshotMessage,
  closedGitEnvironment,
  commitShape,
  createClosedNpmEnvironment,
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
  validatePackageEvidence,
  validateSnapshotShape,
} from './release-publication.mjs';

const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const READY_QA_WORKFLOW = 'ready-release-qa-controller.yml';
const READY_QA_WORKFLOW_PATH = `.github/workflows/${READY_QA_WORKFLOW}`;

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_AUTHORITY_TOKEN_MISSING');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubGet(path) {
  try {
    const response = await fetch(`https://api.github.com${path}`, { headers: githubHeaders() });
    const body = await response.json().catch(() => null);
    if (!response.ok) fail('GITHUB_AUTHORITY_READ_FAILED');
    return body;
  } catch (error) {
    if (error.code) throw error;
    fail('GITHUB_AUTHORITY_READ_FAILED');
  }
}

function remoteRef(repoRoot, fullRef) {
  try {
    const output = execFileSync('git', ['--no-replace-objects', 'ls-remote', '--refs', '--exit-code', 'origin', fullRef], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: closedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) fail('REMOTE_REF_AMBIGUOUS');
    const [sha, ref] = rows[0].split(/\s+/);
    assertSha(sha, 'remote ref');
    if (ref !== fullRef) fail('REMOTE_REF_IDENTITY_INVALID');
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

function pushSnapshot(repoRoot, sha) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail('SNAPSHOT_WRITE_TOKEN_MISSING');
  const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const env = closedGitEnvironment({
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'push.followTags',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_2: authorization,
  });
  try {
    execFileSync(
      'git',
      ['--no-replace-objects', 'push', '--porcelain', '--no-follow-tags', `--force-with-lease=${SNAPSHOT_REF}:`, 'origin', `${sha}:${SNAPSHOT_REF}`],
      { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch {
    fail('SNAPSHOT_REF_WRITE_FAILED');
  }
}

function pullTuple(pull) {
  return {
    id: pull?.id,
    number: pull?.number,
    state: pull?.state,
    draft: pull?.draft,
    merged: pull?.merged,
    merged_at: pull?.merged_at,
    merge_commit_sha: pull?.merge_commit_sha,
    base: { repository: pull?.base?.repo?.full_name, ref: pull?.base?.ref, sha: pull?.base?.sha },
    head: { repository: pull?.head?.repo?.full_name, ref: pull?.head?.ref, sha: pull?.head?.sha },
  };
}

function assertHydratedPull(listed, detail) {
  if (
    !Number.isInteger(detail?.id) || detail.id < 1 || !Number.isInteger(detail.number) || detail.number < 1 ||
    detail.id !== listed.id || detail.number !== listed.number ||
    detail.state !== listed.state || detail.base?.repo?.full_name !== listed.base?.repo?.full_name ||
    detail.base?.ref !== listed.base?.ref || detail.base?.sha !== listed.base?.sha ||
    detail.head?.repo?.full_name !== listed.head?.repo?.full_name || detail.head?.ref !== listed.head?.ref ||
    detail.head?.sha !== listed.head?.sha || typeof detail.draft !== 'boolean' || typeof detail.merged !== 'boolean'
  ) fail('PULL_HYDRATION_IDENTITY_MISMATCH');
  if (!['open', 'closed'].includes(detail.state)) fail('PULL_STATE_INVALID');
  if (detail.merged) {
    if (detail.state !== 'closed' || typeof detail.merged_at !== 'string') fail('PULL_MERGED_TUPLE_INVALID');
    assertSha(detail.merge_commit_sha, 'merged pull commit');
  } else if (detail.merged_at !== null) fail('PULL_MERGED_TUPLE_INVALID');
  assertSha(detail.base.sha, 'pull base');
  assertSha(detail.head.sha, 'pull head');
  return detail;
}

async function pullSweep() {
  const pulls = [];
  const numbers = new Set();
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const listed = await githubGet(`/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(listed) || listed.length > PAGE_SIZE) fail('PULL_HISTORY_PAGE_INVALID');
    for (const summary of listed) {
      if (!Number.isInteger(summary?.number) || summary.number < 1 || numbers.has(summary.number) || !Number.isInteger(summary.id) || summary.id < 1 || ids.has(summary.id)) {
        fail('PULL_HISTORY_DUPLICATE_OR_INVALID');
      }
      numbers.add(summary.number);
      ids.add(summary.id);
      pulls.push(assertHydratedPull(summary, await githubGet(`/repos/${REPOSITORY}/pulls/${summary.number}`)));
    }
    if (listed.length < PAGE_SIZE) return pulls;
  }
  fail('PULL_HISTORY_OVERFLOW');
}

async function stableReleasePulls() {
  const first = await pullSweep();
  const second = await pullSweep();
  if (JSON.stringify(first.map(pullTuple)) !== JSON.stringify(second.map(pullTuple))) fail('PULL_HISTORY_MOVED');
  return second;
}

function runTuple(run) {
  return {
    id: run?.id,
    name: run?.name,
    path: run?.path,
    event: run?.event,
    status: run?.status,
    conclusion: run?.conclusion,
    head_branch: run?.head_branch,
    head_sha: run?.head_sha,
    created_at: run?.created_at,
    updated_at: run?.updated_at,
    repository: run?.repository?.full_name,
    head_repository: run?.head_repository?.full_name,
    artifact_names: [...(run?.artifact_names ?? [])].sort(),
  };
}

async function artifactNames(runId) {
  const names = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await githubGet(`/repos/${REPOSITORY}/actions/runs/${runId}/artifacts?per_page=${PAGE_SIZE}&page=${page}`);
    const batch = value?.artifacts;
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE) fail('QA_ARTIFACT_PAGE_INVALID');
    for (const artifact of batch) {
      if (!Number.isInteger(artifact?.id) || artifact.id < 1 || ids.has(artifact.id) || typeof artifact.name !== 'string') fail('QA_ARTIFACT_IDENTITY_INVALID');
      ids.add(artifact.id);
      names.push(artifact.name);
    }
    if (batch.length < PAGE_SIZE) return names.sort();
  }
  fail('QA_ARTIFACT_HISTORY_OVERFLOW');
}

async function runSweep() {
  const runs = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const value = await githubGet(`/repos/${REPOSITORY}/actions/workflows/${READY_QA_WORKFLOW}/runs?status=success&per_page=${PAGE_SIZE}&page=${page}`);
    const listed = value?.workflow_runs;
    if (!Array.isArray(listed) || listed.length > PAGE_SIZE) fail('QA_RUN_HISTORY_PAGE_INVALID');
    for (const summary of listed) {
      if (!Number.isInteger(summary?.id) || summary.id < 1 || ids.has(summary.id)) fail('QA_RUN_HISTORY_DUPLICATE_OR_INVALID');
      ids.add(summary.id);
      const detail = await githubGet(`/repos/${REPOSITORY}/actions/runs/${summary.id}`);
      if (detail?.id !== summary.id) fail('QA_RUN_HYDRATION_IDENTITY_MISMATCH');
      if (JSON.stringify(runTuple(summary)) !== JSON.stringify(runTuple(detail))) {
        fail('QA_RUN_HYDRATION_IDENTITY_MISMATCH');
      }
      assertSha(detail.head_sha, 'QA controller head');
      detail.artifact_names = await artifactNames(detail.id);
      runs.push(detail);
    }
    if (listed.length < PAGE_SIZE) return runs;
  }
  fail('QA_RUN_HISTORY_OVERFLOW');
}

async function stableQaRuns() {
  const first = await runSweep();
  const second = await runSweep();
  if (JSON.stringify(first.map(runTuple)) !== JSON.stringify(second.map(runTuple))) fail('QA_RUN_HISTORY_MOVED');
  return second;
}

export const liveAdapter = {
  pull: (number) => githubGet(`/repos/${REPOSITORY}/pulls/${number}`),
  releasePulls: stableReleasePulls,
  qaRuns: stableQaRuns,
  artifacts: (id) => githubGet(`/repos/${REPOSITORY}/actions/runs/${id}/artifacts?per_page=100&page=1`),
  ref: remoteRef,
  fetchObjects,
  pushSnapshot,
};

function newest(items, field) {
  return [...items].sort((left, right) => {
    const date = String(right[field] ?? '').localeCompare(String(left[field] ?? ''));
    return date === 0 ? Number(right.id ?? right.number) - Number(left.id ?? left.number) : date;
  })[0];
}

export function validateLatestMergedAuthority({ pull, pulls, runs, prNumber, qaRunExpectation }) {
  const lifecycle = pulls.filter((candidate) =>
    candidate.state === 'closed' &&
    typeof candidate.merged_at === 'string' &&
    candidate.base?.repo?.full_name === REPOSITORY && candidate.base.ref === RELEASE_LINE &&
    candidate.head?.repo?.full_name === REPOSITORY && candidate.head.ref === STAGED_LINE,
  );
  const latest = newest(lifecycle, 'merged_at');
  if (latest && lifecycle.filter((candidate) => candidate.merged_at === latest.merged_at).length !== 1) {
    fail('LATEST_MERGED_RELEASE_PR_AMBIGUOUS');
  }
  if (
    !latest || latest.number !== Number(prNumber) || pull.number !== latest.number || pull.merged !== true ||
    pull.state !== 'closed' || typeof pull.merged_at !== 'string' ||
    pull.base?.repo?.full_name !== REPOSITORY || pull.base.ref !== RELEASE_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY || pull.head.ref !== STAGED_LINE
  ) {
    fail('LATEST_MERGED_RELEASE_PR_MISMATCH');
  }
  if (JSON.stringify(pullTuple(pull)) !== JSON.stringify(pullTuple(latest))) fail('MERGED_RELEASE_PR_AMBIGUOUS');
  const matchingRuns = runs.filter((run) =>
    run.status === 'completed' && run.conclusion === 'success' &&
    run.name === 'Ready release QA controller' && run.path === READY_QA_WORKFLOW_PATH &&
    run.head_branch === 'main' && run.repository?.full_name === REPOSITORY &&
    run.head_repository?.full_name === REPOSITORY &&
    ['workflow_run', 'workflow_dispatch'].includes(run.event) &&
    run.artifact_names?.includes(`ready-release-qa-${pull.head.sha}`),
  );
  const canonicalRun = newest(matchingRuns, 'created_at');
  if (!canonicalRun) fail('CURRENT_READY_QA_AUTHORIZATION_MISSING');
  if (qaRunExpectation && Number(qaRunExpectation) !== canonicalRun.id) fail('QA_RUN_EXPECTATION_STALE');
  return { stagedSha: pull.head.sha, mergeSha: pull.merge_commit_sha, canonicalRun };
}

export async function retainedArtifactAvailable(adapter, runId) {
  try {
    const artifacts = await adapter.artifacts(runId);
    return artifacts.artifacts?.some((artifact) => !artifact.expired) ?? false;
  } catch {
    return false;
  }
}

export async function assertTrustedPreparationMain(repoRoot, adapter) {
  const local = git(repoRoot, 'rev-parse', 'HEAD');
  const remote = await adapter.ref(repoRoot, 'refs/heads/main');
  if (
    local !== remote || process.env.EXPECTED_DISPATCH_SHA !== remote ||
    process.env.EXPECTED_WORKFLOW_SHA !== remote || process.env.GITHUB_REF !== 'refs/heads/main'
  ) fail('TRUSTED_MAIN_IDENTITY_MISMATCH');
  return remote;
}

export async function ensureSnapshotRef({ adapter, repoRoot, snapshotSha }) {
  const existing = await adapter.ref(repoRoot, SNAPSHOT_REF);
  if (existing === snapshotSha) return 'reused';
  if (existing !== null) fail('EXISTING_SNAPSHOT_INCOMPATIBLE');
  let result = 'created';
  try {
    await adapter.pushSnapshot(repoRoot, snapshotSha);
  } catch (error) {
    const raced = await adapter.ref(repoRoot, SNAPSHOT_REF);
    if (raced !== snapshotSha) throw error;
    result = 'created-after-ambiguous-response';
  }
  if (await adapter.ref(repoRoot, SNAPSHOT_REF) !== snapshotSha) fail('SNAPSHOT_REF_READBACK_FAILED');
  return result;
}

function createSnapshotCommit(repoRoot, tree, mergeSha, message) {
  try {
    return execFileSync('git', ['--no-replace-objects', 'commit-tree', tree, '-p', mergeSha], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: message,
      env: closedGitEnvironment({
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail('SNAPSHOT_COMMIT_CREATE_FAILED');
  }
}

function reduced(packages) {
  return packages.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
}

export async function prepareReleaseSnapshot({
  repoRoot,
  prNumber,
  qaRunExpectation = '',
  evidencePath,
  adapter = liveAdapter,
  temporaryBase = tmpdir(),
}) {
  if (!POSITIVE_DECIMAL.test(String(prNumber)) || (qaRunExpectation && !POSITIVE_DECIMAL.test(String(qaRunExpectation)))) {
    fail('SNAPSHOT_ARGUMENTS_INVALID');
  }
  assertSafeGitConfiguration(repoRoot);
  if (git(repoRoot, 'status', '--porcelain') !== '') fail('SNAPSHOT_WORKTREE_DIRTY');
  const temporary = await mkdtemp(join(temporaryBase, 'lab-01-snapshot-'));
  try {
    await assertTrustedPreparationMain(repoRoot, adapter);
    await assertPinnedNpmVersion(join(temporary, 'npm-version'));
    const [pull, pulls, runs] = await Promise.all([adapter.pull(prNumber), adapter.releasePulls(), adapter.qaRuns()]);
    const authority = validateLatestMergedAuthority({ pull, pulls, runs, prNumber, qaRunExpectation });
    await adapter.fetchObjects(repoRoot, [authority.mergeSha, authority.stagedSha]);
    const merge = commitShape(repoRoot, authority.mergeSha);
    if (merge.parents.length !== 2 || merge.parents[1] !== authority.stagedSha) fail('MERGE_PARENT_INVALID');
    const source = commitShape(repoRoot, merge.parents[0]);
    const intent = commitShape(repoRoot, merge.parents[1]);
    intent.sourceTree = source.tree;
    validateIntentShape(intent, source.sha);
    validateMergeShape(merge, source, intent);
    const lineBefore = await adapter.ref(repoRoot, `refs/heads/${RELEASE_LINE}`);
    assertSha(lineBefore, 'release line');
    try { execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', merge.sha, lineBefore], { cwd: repoRoot, env: closedGitEnvironment(), stdio: 'ignore' }); }
    catch { fail('RELEASE_LINE_DOES_NOT_CONTAIN_M'); }
    assertNoTrackedNpmConfiguration(repoRoot, merge.sha);

    const artifactAvailable = await retainedArtifactAvailable(adapter, authority.canonicalRun.id);
    const regenerated = await runReadyReleaseQa({
      repository: REPOSITORY,
      stagedSha: intent.sha,
      sourceSha: source.sha,
      repoRoot,
      authority: localAuthority(),
    });
    const regeneratedPackages = regenerated.registry.packages.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
    validatePackageEvidence(regeneratedPackages);

    const expected = reconstructExpectedSnapshot(repoRoot, merge.sha, join(temporary, 'index'));
    if (
      expected.tree !== regenerated.release.transformedTree ||
      expected.contentSha256 !== regenerated.release.transformedContentSha256
    ) fail('REGENERATED_QA_TREE_MISMATCH');
    const inert = join(temporary, 'inert');
    await materializeInertPackages(repoRoot, expected.tree, inert);
    const npmEnvironment = await createClosedNpmEnvironment(join(temporary, 'npm-pack'));
    const packed = packageEvidence(await packPackages(inert, join(temporary, 'packs'), npmEnvironment));
    if (JSON.stringify(reduced(packed)) !== JSON.stringify(regeneratedPackages)) fail('REGENERATED_QA_PACKAGE_MISMATCH');
    const message = buildSnapshotMessage({
      mergeSha: merge.sha,
      stagedSha: intent.sha,
      sourceSha: source.sha,
      tree: expected.tree,
      contentSha256: expected.contentSha256,
      packages: packed,
    });
    const snapshotSha = createSnapshotCommit(repoRoot, expected.tree, merge.sha, message);
    assertSha(snapshotSha, 'snapshot V');
    const snapshot = validateExactSnapshotTree(repoRoot, merge.sha, snapshotSha, expected.tree);
    const metadata = parseSnapshotMessage(snapshot.message);
    validateSnapshotShape(snapshot, metadata, merge);
    if (metadata.contentSha256 !== expected.contentSha256 || JSON.stringify(metadata.packages) !== JSON.stringify(reduced(packed))) {
      fail('SNAPSHOT_METADATA_CROSSCHECK_FAILED');
    }
    const result = await ensureSnapshotRef({ adapter, repoRoot, snapshotSha });
    const lineAfter = await adapter.ref(repoRoot, `refs/heads/${RELEASE_LINE}`);
    if (lineAfter !== lineBefore) fail('RELEASE_LINE_CHANGED_DURING_SNAPSHOT');
    const evidence = sanitizedEvidence({
      schemaVersion: 2,
      operation: 'prepare-release-snapshot',
      repository: REPOSITORY,
      release: { line: RELEASE_LINE, version: RELEASE_VERSION, sourceSha: source.sha, stagedSha: intent.sha, mergeSha: merge.sha },
      authorization: { latestMergedPullRequest: Number(prNumber), latestSuccessfulQaRun: authority.canonicalRun.id, retainedArtifactAvailable: artifactAvailable },
      regeneration: { transformedTree: expected.tree, transformedContentSha256: expected.contentSha256, consumer: regenerated.consumer.result, cleanup: regenerated.cleanup.result },
      snapshot: { ref: SNAPSHOT_REF, sha: snapshotSha, parent: merge.sha, tree: expected.tree, result, packages: packed },
      safety: { trustedMain: git(repoRoot, 'rev-parse', 'HEAD'), releaseLineBefore: lineBefore, releaseLineAfter: lineAfter, npmMutation: false, tagMutation: false, githubReleaseMutation: false },
    });
    if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined) fail('SNAPSHOT_ARGUMENTS_INVALID');
    values[args[index].slice(2)] = args[index + 1];
  }
  for (const key of ['repository', 'release-pr', 'evidence']) if (!values[key]) fail('SNAPSHOT_ARGUMENTS_INVALID');
  if (values.repository !== REPOSITORY) fail('SNAPSHOT_REPOSITORY_INVALID');
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArguments(process.argv.slice(2));
  prepareReleaseSnapshot({
    repoRoot: git(process.cwd(), 'rev-parse', '--show-toplevel'),
    prNumber: args['release-pr'],
    qaRunExpectation: args['qa-run'] ?? '',
    evidencePath: args.evidence,
  }).then((evidence) => console.log(JSON.stringify({ result: evidence.snapshot.result, snapshot: evidence.snapshot.sha }))).catch((error) => {
    console.error(error.code ?? 'SNAPSHOT_PREPARATION_FAILED');
    process.exitCode = 1;
  });
}
