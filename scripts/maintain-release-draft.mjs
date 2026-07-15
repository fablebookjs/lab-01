import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'fablebookjs/lab-01';
const RELEASE_LINE = 'releases/v1.0';
const STAGED_LINE = 'staged/v1.0';
const BASELINE_TAG = 'v1.0.0';
const RELEASE_VERSION = '1.0.1';
const NEXT_RELEASE_VERSION = '1.0.2';
const INTENT_VERSION = '1';
const READY_QA_WORKFLOW = 'ready-release-qa.yml';
const SNAPSHOT_REF = 'release-snapshots/v1.0.1';
const HISTORY_PAGE_SIZE = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fail = (message) => {
  throw new Error(message);
};

export function parseIntentMessage(message) {
  const lines = message.trimEnd().split('\n');
  const subject = lines.shift();
  const trailers = new Map();

  for (const line of lines) {
    if (line === '') continue;
    const match = /^([A-Za-z0-9-]+): (.+)$/.exec(line);
    if (!match || trailers.has(match[1])) {
      fail(`invalid or duplicate release-intent trailer: ${line}`);
    }
    trailers.set(match[1], match[2]);
  }

  return { subject, trailers };
}

export function validateIntent(
  { message, parents, commitTree, parentTree },
  { source, line = RELEASE_LINE, version = RELEASE_VERSION } = {},
) {
  if (!SHA_PATTERN.test(source ?? '')) fail('release intent has an invalid expected source SHA');
  if (parents.length !== 1) fail('release intent must have exactly one parent');
  if (parents[0] !== source) fail('release intent parent does not equal its source');
  if (commitTree !== parentTree) fail('release intent changes the source tree');

  const { subject, trailers } = parseIntentMessage(message);
  const expected = new Map([
    ['Release-Intent-Version', INTENT_VERSION],
    ['Release-Line', line],
    ['Release-Version', version],
    ['Release-Source', source],
  ]);

  if (subject !== `release: propose v${version}`) fail('release intent has an unexpected subject');
  if (trailers.size !== expected.size) fail('release intent has unexpected trailers');
  for (const [key, value] of expected) {
    if (trailers.get(key) !== value) fail(`release intent has an invalid ${key} trailer`);
  }
}

export function buildIntentMessage({ source, version = RELEASE_VERSION } = {}) {
  if (!SHA_PATTERN.test(source ?? '')) fail('release intent has an invalid source SHA');
  return `release: propose v${version}\n\nRelease-Intent-Version: ${INTENT_VERSION}\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${version}\nRelease-Source: ${source}\n`;
}

export function buildPullRequestBody({ source, intent, includedCommits }) {
  const commits =
    includedCommits.length === 0
      ? '- None; the proposed source is the `v1.0.0` baseline.'
      : includedCommits.map(({ sha, subject }) => `- \`${sha}\` ${subject}`).join('\n');

  return `## Release intent

- Release line: \`${RELEASE_LINE}\`
- Proposed version: \`${RELEASE_VERSION}\`
- Exact release source: \`${source}\`
- Structured intent commit: \`${intent}\`

The structured empty commit is authoritative. This editable title and body are presentation only.

## Included commits since \`${BASELINE_TAG}\`

${commits}

## Current lifecycle state

Automatic release-PR maintenance is live. A push to \`${RELEASE_LINE}\` refreshes this same PR from the exact new release-line head while preserving its number, base, head, and draft-or-ready review state.

Ready-state exact-version QA is live. Marking the current proposal ready runs QA for that exact head. When a ready proposal refreshes, release-PR maintenance explicitly dispatches QA for the new staged head because GitHub leaves token-authored synchronize runs approval-required. The first ready proof is [run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684), and the first automatically refreshed-head proof is [run 29414043206](https://github.com/fablebookjs/lab-01/actions/runs/29414043206). Close-and-regenerate is live: [run 29414470336](https://github.com/fablebookjs/lab-01/actions/runs/29414470336) closed historical PR #1, created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12), and converged on that same replacement when rerun. Offline snapshot and direct-OIDC publisher preparation exists, but public baseline packages, npm trusted-publisher settings, the GitHub environment, and current-head QA remain external gates. Do not merge this release PR until all gates are satisfied.
Ready-state exact-version QA is live. Marking the current proposal ready runs QA for that exact head. When a ready proposal refreshes, release-PR maintenance explicitly dispatches QA for the new staged head because GitHub leaves token-authored synchronize runs approval-required. The first ready proof is [run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684), and the first automatically refreshed-head proof is [run 29414043206](https://github.com/fablebookjs/lab-01/actions/runs/29414043206). Close-and-regenerate is live: [run 29414470336](https://github.com/fablebookjs/lab-01/actions/runs/29414470336) closed historical PR #1, created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12), and converged on that same replacement when rerun. Offline snapshot and direct-OIDC publisher preparation exists, but public baseline packages, npm trusted-publisher settings, the GitHub environment, and current-head QA remain external gates.

This maintainer never publishes, reconciles the release line, tags, or creates a GitHub Release. After an exact merge, it validates the sealed M/post-M handoff and leaves all writes to the separately reviewed issue #19 finalizer. It likewise recognizes the finalizer's exact draft \`1.0.2\` proposal without refreshing it as \`1.0.1\` or dispatching \`1.0.1\` QA. That finalizer is not installed by this change; merge only when the issue #19 operator gate says it is ready.

See [docs/release-process.md](https://github.com/${REPOSITORY}/blob/${RELEASE_LINE}/docs/release-process.md) for the current contract and safety boundary.`;
}

function refSha(ref) {
  const output = git('ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`);
  const rows = output.split('\n').filter(Boolean);
  if (rows.length !== 1) fail(`expected exactly one remote ${ref} ref`);
  const [sha, name] = rows[0].split(/\s+/);
  if (!SHA_PATTERN.test(sha) || name !== `refs/heads/${ref}`) fail(`unexpected remote ${ref} ref`);
  return sha;
}

function optionalRefSha(ref) {
  try {
    return refSha(ref);
  } catch (error) {
    if (error.status === 2 || /exit code 2|status 2|exit status 2/.test(error.message)) return null;
    throw error;
  }
}

function commitShape(sha) {
  const row = git('rev-list', '--parents', '-n', '1', sha).split(' ');
  return {
    sha,
    message: git('show', '-s', '--format=%B', sha),
    parents: row.slice(1),
    commitTree: git('rev-parse', `${sha}^{tree}`),
    parentTree: row.length === 2 ? git('rev-parse', `${row[1]}^{tree}`) : '',
  };
}

function manifestAt(commit, manifest) {
  return JSON.parse(git('show', `${commit}:${manifest}`));
}

function validateBaseline(source) {
  const baseline = git('rev-parse', `${BASELINE_TAG}^{commit}`);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseline, source], { stdio: 'ignore' });
  } catch {
    fail(`${RELEASE_LINE} is not descended from ${BASELINE_TAG}`);
  }

  for (const manifest of ['package.json', 'packages/core/package.json', 'packages/addon/package.json']) {
    if (manifestAt(baseline, manifest).version !== '1.0.0') {
      fail(`${BASELINE_TAG} does not contain the expected 1.0.0 baseline`);
    }
    if (manifestAt(source, manifest).version !== '1.0.0') {
      fail(`${RELEASE_LINE} no longer contains the expected unreleased 1.0.0 manifests`);
    }
  }
  return baseline;
}

function validateExistingStagedIntent(staged, source) {
  const shape = commitShape(staged);
  if (shape.parents.length !== 1) fail('existing staged intent must have exactly one parent');
  const stagedSource = shape.parents[0];
  validateIntent(shape, { source: stagedSource });

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', stagedSource, source], { stdio: 'ignore' });
  } catch {
    fail('existing staged intent is not based on the current release-line history');
  }
  return stagedSource === source;
}

function createIntent(source) {
  const message = buildIntentMessage({ source });
  return execFileSync('git', ['commit-tree', `${source}^{tree}`, '-p', source], {
    encoding: 'utf8',
    input: message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    },
  }).trim();
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`GitHub API ${options.method ?? 'GET'} ${path} failed with ${response.status}`);
  return body;
}

export function assertMatchingReleasePull(pull) {
  if (
    pull.state !== 'open' ||
    typeof pull.draft !== 'boolean' ||
    pull.base?.ref !== RELEASE_LINE ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    pull.head?.ref !== STAGED_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY
  ) {
    fail('the matching release PR is not the expected open lifecycle PR');
  }
}

function isMergedPull(pull) {
  return pull.merged === true || (pull.state === 'closed' && typeof pull.merged_at === 'string');
}

function isLifecycleCandidate(pull) {
  return pull?.head?.ref === STAGED_LINE;
}

function assertLifecycleIdentity(pull) {
  if (
    !Number.isInteger(pull?.number) ||
    pull.number < 1 ||
    pull.base?.ref !== RELEASE_LINE ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    pull.head?.ref !== STAGED_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY
  ) {
    fail('release lifecycle PR has an unexpected repository or branch identity');
  }
}

function intentVersion(shape) {
  const { trailers } = parseIntentMessage(shape.message);
  return trailers.get('Release-Version');
}

function requireCommit(observation, sha, label) {
  const shape = observation.commits?.[sha];
  if (!shape || shape.sha !== sha) fail(`${label} commit evidence is missing or stale`);
  return shape;
}

function validateMergedLifecycle(observation, pull) {
  if (pull.state !== 'closed' || !isMergedPull(pull)) {
    fail('latest release lifecycle PR is closed without a merge commit');
  }
  for (const [value, label] of [
    [pull.base?.sha, 'merged release source'],
    [pull.head?.sha, 'merged staged intent'],
    [pull.merge_commit_sha, 'merged release commit'],
  ]) {
    if (!SHA_PATTERN.test(value ?? '')) fail(`${label} is not a full SHA`);
  }
  if (observation.stagedSha !== pull.head.sha) {
    fail('staged ref no longer identifies the merged lifecycle intent');
  }

  const source = requireCommit(observation, pull.base.sha, 'release source');
  const intent = requireCommit(observation, pull.head.sha, 'release intent');
  validateIntent(intent, { source: source.sha, version: RELEASE_VERSION });
  const merge = requireCommit(observation, pull.merge_commit_sha, 'sealed merge');
  if (
    merge.parents.length !== 2 ||
    merge.parents[0] !== source.sha ||
    merge.parents[1] !== intent.sha ||
    merge.commitTree !== source.commitTree ||
    intent.commitTree !== source.commitTree
  ) {
    fail('sealed merge is not the ordered [source, intent] merge with the sealed source tree');
  }
  return { source, intent, merge };
}

function validateSnapshot(snapshot, { source, intent, merge }) {
  if (snapshot === null) return null;
  if (
    snapshot.ref !== `refs/heads/${SNAPSHOT_REF}` ||
    !SHA_PATTERN.test(snapshot.sha ?? '') ||
    snapshot.sha !== snapshot.commit?.sha
  ) {
    fail('release snapshot ref does not identify exact V');
  }
  const commit = snapshot.commit;
  if (
    commit.parents.length !== 1 ||
    commit.parents[0] !== merge.sha ||
    commit.commitTree === merge.commitTree
  ) {
    fail('V is not the exact one-parent transformed snapshot over M');
  }
  const { subject, trailers } = parseIntentMessage(commit.message);
  const required = [
    'Release-Snapshot-Version',
    'Release-Line',
    'Release-Version',
    'Release-Merge',
    'Release-QA-Run',
    'Release-QA-Staged',
    'Release-QA-Source',
    'Core-Integrity',
    'Core-Shasum',
    'Addon-Integrity',
    'Addon-Shasum',
  ];
  if (
    subject !== `release: snapshot v${RELEASE_VERSION}` ||
    trailers.size !== required.length ||
    required.some((key) => !trailers.has(key)) ||
    trailers.get('Release-Snapshot-Version') !== '1' ||
    trailers.get('Release-Line') !== RELEASE_LINE ||
    trailers.get('Release-Version') !== RELEASE_VERSION ||
    trailers.get('Release-Merge') !== merge.sha ||
    trailers.get('Release-QA-Staged') !== intent.sha ||
    trailers.get('Release-QA-Source') !== source.sha ||
    !/^[1-9]\d*$/.test(trailers.get('Release-QA-Run') ?? '') ||
    !INTEGRITY_PATTERN.test(trailers.get('Core-Integrity') ?? '') ||
    !INTEGRITY_PATTERN.test(trailers.get('Addon-Integrity') ?? '') ||
    !SHA_PATTERN.test(trailers.get('Core-Shasum') ?? '') ||
    !SHA_PATTERN.test(trailers.get('Addon-Shasum') ?? '')
  ) {
    fail('release snapshot metadata is incomplete or incompatible');
  }
  return commit;
}

function validateInjectedPostMerge(binding, context, observation) {
  if (
    binding?.observer !== 'issue-19-finalizer' ||
    binding.schemaVersion !== 1 ||
    binding.line !== RELEASE_LINE ||
    binding.version !== RELEASE_VERSION ||
    binding.mergeSha !== context.merge.sha ||
    binding.headSha !== observation.releaseHeadSha
  ) {
    fail('post-M release line lacks an exact finalizer observation binding');
  }

  if (binding.kind === 'late-head') {
    if (
      binding.verifiedMergeSha !== context.merge.sha ||
      binding.headSha === context.merge.sha ||
      binding.headSha === context.intent.sha ||
      binding.headSha === context.source.sha ||
      binding.snapshotSha !== (context.snapshot?.sha ?? null)
    ) {
      fail('late H finalizer binding is contradictory');
    }
    return { owner: 'finalizer-owns-release', state: 'late-head', mergeSha: context.merge.sha };
  }

  if (binding.kind === 'normal-reconciliation') {
    if (context.snapshot === null) fail('normal J requires the deterministic V snapshot');
    const reconciliation = requireCommit(observation, binding.headSha, 'normal reconciliation');
    if (
      binding.snapshotSha !== context.snapshot.sha ||
      !SHA_PATTERN.test(binding.lateHeadSha ?? '') ||
      binding.lateHeadSha === context.merge.sha ||
      reconciliation.parents.length !== 2 ||
      reconciliation.parents[0] !== binding.lateHeadSha ||
      reconciliation.parents[1] !== context.snapshot.sha ||
      reconciliation.commitTree !== binding.expectedTreeSha ||
      binding.metadata?.schemaVersion !== 1 ||
      binding.metadata.line !== RELEASE_LINE ||
      binding.metadata.version !== RELEASE_VERSION ||
      binding.metadata.mergeSha !== context.merge.sha ||
      binding.metadata.snapshotSha !== context.snapshot.sha ||
      binding.metadata.lateHeadSha !== binding.lateHeadSha
    ) {
      fail('normal J finalizer binding or graph is contradictory');
    }
    return { owner: 'finalizer-owns-release', state: 'normal-reconciliation', mergeSha: context.merge.sha };
  }

  fail('post-M finalizer observation has an unknown state kind');
}

export function classifyMaintainerOwnership(observation) {
  if (!SHA_PATTERN.test(observation?.releaseHeadSha ?? '') || !SHA_PATTERN.test(observation?.stagedSha ?? '')) {
    fail('maintainer observation has an invalid current ref SHA');
  }
  if (!Array.isArray(observation.pulls)) fail('maintainer observation has no PR history');

  const candidates = observation.pulls.filter(isLifecycleCandidate);
  candidates.forEach(assertLifecycleIdentity);
  const seen = new Set();
  for (const pull of candidates) {
    if (seen.has(pull.number)) fail(`release lifecycle PR #${pull.number} is duplicated in history`);
    seen.add(pull.number);
  }

  const open = candidates.filter((pull) => pull.state === 'open');
  if (open.length > 1) fail(`expected at most one open release lifecycle PR, found ${open.length}`);
  if (open.length === 1) {
    const pull = open[0];
    if (typeof pull.draft !== 'boolean') fail('open release lifecycle PR has no draft/ready state');
    if (pull.head.sha !== observation.stagedSha) fail('open release PR head does not equal staged ref');
    const intent = requireCommit(observation, observation.stagedSha, 'open release intent');
    const version = intentVersion(intent);
    if (version === RELEASE_VERSION) {
      return { owner: 'maintainer', state: pull.draft ? 'draft' : 'ready', pullNumber: pull.number };
    }
    if (version !== NEXT_RELEASE_VERSION) fail(`open release proposal has unexpected version ${version ?? '<missing>'}`);
    if (observation.historyComplete !== true) fail('next-proposal ownership requires complete all-state PR history');
    if (pull.number !== Math.max(...candidates.map((candidate) => candidate.number))) {
      fail('open next proposal is not the unique latest lifecycle PR');
    }
    if (pull.draft !== true) fail('the next 1.0.2 proposal must be draft');
    validateIntent(intent, { source: observation.releaseHeadSha, version: NEXT_RELEASE_VERSION });
    return {
      owner: 'next-proposal-owned',
      state: 'draft',
      pullNumber: pull.number,
      sourceSha: observation.releaseHeadSha,
      intentSha: observation.stagedSha,
      version: NEXT_RELEASE_VERSION,
    };
  }

  if (observation.historyComplete !== true) fail('all-state release PR history is incomplete or ambiguous');
  if (candidates.length === 0) fail('release lifecycle PR history is missing');
  const latestNumber = Math.max(...candidates.map((pull) => pull.number));
  const latest = candidates.find((pull) => pull.number === latestNumber);
  const context = validateMergedLifecycle(observation, latest);
  context.snapshot = validateSnapshot(observation.snapshot ?? null, context);

  if (observation.releaseHeadSha === context.merge.sha) {
    return { owner: 'finalizer-owns-release', state: 'sealed-merge', mergeSha: context.merge.sha };
  }
  if (context.snapshot !== null && observation.releaseHeadSha === context.snapshot.sha) {
    return { owner: 'finalizer-owns-release', state: 'version-snapshot', mergeSha: context.merge.sha };
  }
  return validateInjectedPostMerge(observation.postMerge, context, observation);
}

export async function settleMaintainerOwnership({ observation, effects }) {
  const decision = classifyMaintainerOwnership(observation);
  if (decision.owner !== 'maintainer') return decision;
  if (typeof effects?.maintain !== 'function') fail('normal maintenance requires an explicit effect adapter');
  return effects.maintain(decision);
}

export async function readCompletePullHistory({ request, maxPages = 20, state = 'all' } = {}) {
  if (typeof request !== 'function') fail('PR history requires a request function');
  if (!Number.isInteger(maxPages) || maxPages < 1) fail('PR history maxPages must be positive');
  if (!['all', 'open'].includes(state)) fail('PR history state filter is invalid');
  const pulls = [];
  const seen = new Set();
  let firstPageNumbers = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const path = `/repos/${REPOSITORY}/pulls?state=${state}&per_page=${HISTORY_PAGE_SIZE}&page=${page}`;
    const batch = await request(
      path,
    );
    if (!Array.isArray(batch) || batch.length > HISTORY_PAGE_SIZE) fail('GitHub returned an invalid PR history page');
    if (page === 1) firstPageNumbers = batch.map((pull) => pull?.number);
    for (const pull of batch) {
      if (!Number.isInteger(pull?.number) || seen.has(pull.number)) {
        fail('GitHub returned duplicate or malformed paginated PR history');
      }
      seen.add(pull.number);
      pulls.push(pull);
    }
    if (batch.length < HISTORY_PAGE_SIZE) {
      const firstPage = await request(
        `/repos/${REPOSITORY}/pulls?state=${state}&per_page=${HISTORY_PAGE_SIZE}&page=1`,
      );
      if (
        !Array.isArray(firstPage) ||
        JSON.stringify(firstPage.map((pull) => pull?.number)) !== JSON.stringify(firstPageNumbers)
      ) {
        fail('PR history changed while paginating');
      }
      return pulls;
    }
  }
  fail('all-state PR history exceeded the explicit pagination bound');
}

export async function dispatchReadyQaIfNeeded({ pull, intent, request }) {
  assertMatchingReleasePull(pull);
  if (!SHA_PATTERN.test(intent ?? '')) fail('ready QA dispatch has an invalid intent SHA');
  if (pull.draft) return { action: 'not-dispatched-draft' };
  if (pull.head?.sha !== intent) {
    fail('ready release PR head does not equal the dispatched intent');
  }
  if (typeof request !== 'function') fail('ready QA dispatch requires a request function');

  await request(`/repos/${REPOSITORY}/actions/workflows/${READY_QA_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: STAGED_LINE }),
  });
  return { action: 'dispatched-ready-qa', intent };
}

async function findReleasePull() {
  const pulls = await readCompletePullHistory({ request: github, state: 'open' });
  pulls.filter(isLifecycleCandidate).forEach(assertLifecycleIdentity);
  const matching = pulls.filter(
    (pull) => pull.head?.ref === STAGED_LINE && pull.head?.repo?.full_name === REPOSITORY,
  );
  if (matching.length > 1) fail(`expected at most one matching open release PR, found ${matching.length}`);
  if (matching.length === 0) return null;
  assertMatchingReleasePull(matching[0]);
  return matching[0];
}

async function waitForPullHead(pullNumber, intent) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const pull = await github(`/repos/${REPOSITORY}/pulls/${pullNumber}`);
    assertMatchingReleasePull(pull);
    if (pull.head.sha === intent) return pull;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  fail('release PR did not converge on the current staged intent');
}

function includedCommits(baseline, source) {
  const output = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..${source}`);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

function replacePull(pulls, detail) {
  return pulls.map((pull) => (pull.number === detail.number ? detail : pull));
}

function commitEvidence(shas) {
  const commits = {};
  for (const sha of shas) {
    if (SHA_PATTERN.test(sha ?? '') && !(sha in commits)) commits[sha] = commitShape(sha);
  }
  return commits;
}

function readSnapshotObservation() {
  const sha = optionalRefSha(SNAPSHOT_REF);
  if (sha === null) return null;
  git(
    'fetch',
    '--force',
    '--no-tags',
    'origin',
    `+refs/heads/${SNAPSHOT_REF}:refs/remotes/origin/${SNAPSHOT_REF}`,
  );
  if (git('rev-parse', `refs/remotes/origin/${SNAPSHOT_REF}`) !== sha) {
    fail('release snapshot ref changed while reading finalizer state');
  }
  return { ref: `refs/heads/${SNAPSHOT_REF}`, sha, commit: commitShape(sha) };
}

async function emitSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Draft release maintenance\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
  return summary;
}

export async function main({
  dryRun = process.argv.includes('--dry-run'),
  postMergeObserver = null,
} = {}) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) {
    fail(`refusing to write outside ${REPOSITORY}`);
  }
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is required');

  git(
    'fetch',
    '--force',
    '--no-tags',
    'origin',
    `+refs/heads/${RELEASE_LINE}:refs/remotes/origin/${RELEASE_LINE}`,
    `+refs/heads/${STAGED_LINE}:refs/remotes/origin/${STAGED_LINE}`,
    `refs/tags/${BASELINE_TAG}:refs/tags/${BASELINE_TAG}`,
  );

  const releaseSource = git('rev-parse', `refs/remotes/origin/${RELEASE_LINE}`);
  const previousIntent = git('rev-parse', `refs/remotes/origin/${STAGED_LINE}`);
  if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== previousIntent) {
    fail('remote refs changed while reading state; a later wake-up must reconcile them');
  }

  const pull = await findReleasePull();
  if (pull === null) {
    const history = await readCompletePullHistory({ request: github });
    const candidates = history.filter(isLifecycleCandidate);
    if (candidates.length === 0) {
      classifyMaintainerOwnership({
        releaseHeadSha: releaseSource,
        stagedSha: previousIntent,
        pulls: history,
        historyComplete: true,
        commits: {},
      });
    }
    const latest = candidates.reduce((left, right) => (left.number > right.number ? left : right));
    const detail = await github(`/repos/${REPOSITORY}/pulls/${latest.number}`);
    const pulls = replacePull(history, detail);
    const snapshot = readSnapshotObservation();
    const commits = commitEvidence([
      detail.base?.sha,
      detail.head?.sha,
      detail.merge_commit_sha,
      snapshot?.sha,
      releaseSource,
    ]);
    const postMerge =
      typeof postMergeObserver === 'function'
        ? await postMergeObserver({
            releaseHeadSha: releaseSource,
            stagedSha: previousIntent,
            latestPull: detail,
            snapshot,
            commits,
          })
        : null;
    const decision = await settleMaintainerOwnership({
      observation: {
        releaseHeadSha: releaseSource,
        stagedSha: previousIntent,
        pulls,
        historyComplete: true,
        commits,
        snapshot,
        postMerge,
      },
      effects: null,
    });
    if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== previousIntent) {
      fail('release refs changed while validating finalizer ownership');
    }
    if ((await findReleasePull()) !== null) {
      fail('an open release proposal appeared while validating finalizer ownership');
    }
    return emitSummary({
      repository: REPOSITORY,
      event: process.env.GITHUB_EVENT_NAME ?? 'local',
      actor: process.env.GITHUB_ACTOR ?? 'local',
      action: decision.owner,
      ownershipState: decision.state,
      releaseSource,
      previousIntent,
      intent: previousIntent,
      qaDispatch: { action: 'not-dispatched-owner-handoff' },
      pullRequest: detail.number,
    });
  }
  if (pull.head.sha !== previousIntent) fail('release PR head does not equal the staged ref');

  const observedIntent = commitShape(previousIntent);
  const observedVersion = intentVersion(observedIntent);
  if (observedVersion === NEXT_RELEASE_VERSION) {
    const currentPull = await github(`/repos/${REPOSITORY}/pulls/${pull.number}`);
    const history = replacePull(await readCompletePullHistory({ request: github }), currentPull);
    const decision = await settleMaintainerOwnership({
      observation: {
        releaseHeadSha: releaseSource,
        stagedSha: previousIntent,
        pulls: history,
        historyComplete: true,
        commits: { [previousIntent]: observedIntent },
        snapshot: null,
        postMerge: null,
      },
      effects: null,
    });
    if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== previousIntent) {
      fail('release refs changed while validating next-proposal ownership');
    }
    const finalPull = await findReleasePull();
    if (
      finalPull?.number !== currentPull.number ||
      finalPull.draft !== currentPull.draft ||
      finalPull.head?.sha !== currentPull.head?.sha ||
      finalPull.base?.ref !== currentPull.base?.ref
    ) {
      fail('next proposal changed while validating maintainer ownership');
    }
    return emitSummary({
      repository: REPOSITORY,
      event: process.env.GITHUB_EVENT_NAME ?? 'local',
      actor: process.env.GITHUB_ACTOR ?? 'local',
      action: decision.owner,
      ownershipState: decision.state,
      releaseSource,
      previousIntent,
      intent: previousIntent,
      qaDispatch: { action: 'not-dispatched-owner-handoff' },
      pullRequest: currentPull.number,
    });
  }
  if (observedVersion !== RELEASE_VERSION) {
    fail(`open release proposal has unexpected version ${observedVersion ?? '<missing>'}`);
  }

  const baseline = validateBaseline(releaseSource);
  const alreadyCurrent = validateExistingStagedIntent(previousIntent, releaseSource);
  let intent = previousIntent;

  if (!alreadyCurrent && !dryRun) {
    intent = createIntent(releaseSource);
    validateIntent(commitShape(intent), { source: releaseSource });

    if (refSha(RELEASE_LINE) !== releaseSource) {
      fail('release line advanced before the guarded staged write; a later wake-up must win');
    }
    if (refSha(STAGED_LINE) !== previousIntent) {
      fail('staged ref advanced before the guarded staged write; refusing to overwrite it');
    }

    git(
      'push',
      `--force-with-lease=refs/heads/${STAGED_LINE}:${previousIntent}`,
      'origin',
      `${intent}:refs/heads/${STAGED_LINE}`,
    );

    if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== intent) {
      fail('remote refs did not match the guarded staged update');
    }
  }

  const commits = includedCommits(baseline, releaseSource);
  let qaDispatch = {
    action: pull.draft ? 'not-dispatched-draft' : 'would-dispatch-ready-qa',
    ...(pull.draft ? {} : { intent: alreadyCurrent ? intent : null }),
  };
  if (!dryRun) {
    const currentPull = await waitForPullHead(pull.number, intent);

    const body = buildPullRequestBody({ source: releaseSource, intent, includedCommits: commits });
    await github(`/repos/${REPOSITORY}/pulls/${pull.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    qaDispatch = await dispatchReadyQaIfNeeded({
      pull: currentPull,
      intent,
      request: github,
    });
  }

  const summary = {
    repository: REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    actor: process.env.GITHUB_ACTOR ?? 'local',
    pullRequest: pull.number,
    action: alreadyCurrent
      ? dryRun
        ? 'would-reuse-current-intent'
        : 'reused-current-intent'
      : dryRun
        ? 'would-refresh-intent'
        : 'refreshed-intent',
    releaseSource,
    previousIntent,
    intent: alreadyCurrent || !dryRun ? intent : null,
    qaDispatch,
    includedCommits: commits.map(({ sha }) => sha),
  };
  await emitSummary(summary);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
