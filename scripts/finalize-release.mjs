import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  PACKAGE_SPECS,
  REGISTRY,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  STAGED_LINE,
  TRANSFORMED_FILES,
  assertSafeGitConfiguration,
  assertSha,
  commitShape,
  fail,
  git,
  parseSnapshotMessage,
  parseTrailers,
  validateIntentShape,
  validateMergeShape,
  validatePackageEvidence,
  validateSnapshotShape,
} from './release-publication.mjs';

export const DEFAULT_BRANCH = 'main';
export const RELEASE_REF = `refs/heads/${RELEASE_LINE}`;
export const STAGED_REF = `refs/heads/${STAGED_LINE}`;
export const RECOVERY_LINE = 'recovery/v1.0/1.0.1';
export const RECOVERY_REF = `refs/heads/${RECOVERY_LINE}`;
export const TAG_NAME = 'v1.0.1';
export const TAG_REF = `refs/tags/${TAG_NAME}`;
export const NEXT_VERSION = '1.0.2';
export const FAULTS = Object.freeze(['none', 'after-github-release-post']);
export const FINALIZER_PERMISSIONS = Object.freeze({ contents: 'write', pullRequests: 'write' });

const SHA = /^[0-9a-f]{40}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const HOSTILE_GIT_ENVIRONMENT = [
  /^GIT_ALTERNATE_OBJECT_DIRECTORIES$/,
  /^GIT_COMMON_DIR$/,
  /^GIT_CONFIG/,
  /^GIT_DIR$/,
  /^GIT_GRAFT_FILE$/,
  /^GIT_INDEX_FILE$/,
  /^GIT_NAMESPACE$/,
  /^GIT_OBJECT_DIRECTORY$/,
  /^GIT_REPLACE_REF_BASE$/,
  /^GIT_SHALLOW_FILE$/,
  /^GIT_SSH(?:_COMMAND|_VARIANT)?$/,
  /^GIT_WORK_TREE$/,
];
const FINALIZER_IDENTITY = Object.freeze({
  name: 'Fablebook Lab Finalizer',
  email: 'lab-finalizer@fablebook.invalid',
  date: '2026-07-16T00:00:00Z',
});

function exactRepository(repository, directory) {
  return repository?.type === 'git' && repository.url === REPOSITORY_URL && repository.directory === directory;
}

function refSha(refs, name) {
  return refs[name]?.sha ?? null;
}

function commitSubject(commit) {
  return commit.message.split('\n', 1)[0];
}

function sameRepositorySide(side, ref) {
  return side?.repo?.full_name === REPOSITORY && side.ref === ref;
}

function pullState(pull) {
  if (pull.state === 'open' && pull.merged_at === null) return 'open';
  if (pull.state === 'closed' && pull.merged_at === null) return 'closed-unmerged';
  if (pull.state === 'closed' && typeof pull.merged_at === 'string' && pull.merged_at) return 'closed-merged';
  fail(`pull request #${pull.number ?? 'unknown'} has a contradictory state tuple`);
}

function assertUniqueNumbers(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (!Number.isInteger(item.number) || item.number < 1 || seen.has(item.number)) {
      fail(`${label} contains an invalid or duplicate pull request number`);
    }
    seen.add(item.number);
  }
}

export function reconciliationMessage({ mergeSha, lateSha, snapshotSha }) {
  return `release: reconcile v${RELEASE_VERSION}\n\nRelease-Reconciliation-Version: 1\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${RELEASE_VERSION}\nRelease-Merge: ${mergeSha}\nRelease-Late-Head: ${lateSha}\nRelease-Snapshot: ${snapshotSha}\n`;
}

export function nextIntentMessage(sourceSha) {
  return `release: propose v${NEXT_VERSION}\n\nRelease-Intent-Version: 1\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${NEXT_VERSION}\nRelease-Source: ${sourceSha}\n`;
}

export function nextProposalTitle() {
  return `release: propose v${NEXT_VERSION}`;
}

export function nextProposalBody(state) {
  const commits = state.line.remaining.map(({ sha, subject }) => `- \`${sha}\` — ${subject}`).join('\n');
  return `## Fablebook lab release proposal ${NEXT_VERSION}\n\n` +
    `This draft contains the ordered work that remained after ${TAG_NAME}.\n\n${commits}\n\n` +
    `### Lifecycle\n\n` +
    `- Mark this draft ready to run exact-version release QA.\n` +
    `- Additional release-line fixes refresh and revalidate the proposal.\n` +
    `- Merge the current green proposal to authorize publication.\n` +
    `- Close an unmerged proposal to request one clean replacement draft.\n\n` +
    `The ${TAG_NAME} tag remains bound to snapshot \`${state.graph.snapshot.sha}\`; the commits above were not part of ${RELEASE_VERSION}.`;
}

export function githubReleaseBody(state) {
  const packages = state.packages.expected
    .map((item) => `- \`${item.name}@${RELEASE_VERSION}\`: SHA-512 \`${item.integrity}\`, SHA-1 \`${item.shasum}\``)
    .join('\n');
  return `## Fablebook lab release ${TAG_NAME}\n\n` +
    `This laboratory Release is resolved through lightweight tag \`${TAG_NAME}\` to immutable snapshot \`${state.graph.snapshot.sha}\`.\n\n` +
    `- Sealed merge M: \`${state.graph.merge.sha}\`\n` +
    `- Staged intent I: \`${state.graph.intent.sha}\`\n` +
    `- Release source S: \`${state.graph.source.sha}\`\n` +
    `- Accepted snapshot QA authority: \`${state.graph.authority.qa.label}\`\n\n` +
    `${packages}\n\n` +
    `Commits after M are excluded from ${TAG_NAME} and remain visible for the next patch proposal.`;
}

function validateNextIntent(commit, source) {
  if (commit.parents.length !== 1 || commit.parents[0] !== source.sha || commit.tree !== source.tree) {
    fail('the 1.0.2 staged intent is not an exact empty commit over the current release line');
  }
  const trailers = parseTrailers(commit.message, `release: propose v${NEXT_VERSION}`);
  const expected = new Map([
    ['Release-Intent-Version', '1'],
    ['Release-Line', RELEASE_LINE],
    ['Release-Version', NEXT_VERSION],
    ['Release-Source', source.sha],
  ]);
  if (trailers.size !== expected.size) fail('the 1.0.2 staged intent has unexpected trailers');
  for (const [key, value] of expected) {
    if (trailers.get(key) !== value) fail(`the 1.0.2 staged intent has an invalid ${key}`);
  }
}

function validateNpmObservation(observation, expected, spec) {
  if (observation.status === 'absent') return;
  if (observation.status !== 'present' || observation.name !== spec.name || observation.version !== RELEASE_VERSION) {
    fail(`PERMANENT STOP: npm ${spec.name}@${RELEASE_VERSION} has an incompatible identity`);
  }
  if (!exactRepository(observation.repository, spec.directory)) {
    fail(`PERMANENT STOP: npm ${spec.name}@${RELEASE_VERSION} has an incompatible repository identity`);
  }
  if (
    observation.metadataIntegrity !== expected.integrity ||
    observation.metadataShasum !== expected.shasum ||
    observation.downloadedIntegrity !== expected.integrity ||
    observation.downloadedShasum !== expected.shasum
  ) {
    fail(`PERMANENT STOP: npm ${spec.name}@${RELEASE_VERSION} metadata or downloaded bytes do not match V`);
  }
  if (spec.choice === 'addon') {
    const dependencies = observation.dependencies ?? {};
    if (
      dependencies[PACKAGE_SPECS[0].name] !== RELEASE_VERSION ||
      Object.keys(dependencies).length !== 1
    ) {
      fail(`PERMANENT STOP: npm add-on does not have the exact core ${RELEASE_VERSION} dependency`);
    }
  }
}

async function deriveLine({ gitAdapter, readCommit, headSha, merge, snapshot, recoverySha }) {
  if (headSha === merge.sha) return { kind: 'merge', headSha, remaining: [] };
  if (headSha === snapshot.sha) return { kind: 'version', headSha, remaining: [] };

  const head = await readCommit(headSha);
  if (head.parents.length === 1 && head.parents[0] === merge.sha) {
    if (await gitAdapter.isAncestor(head.sha, snapshot.sha)) fail('late head X is unexpectedly reachable from V');
    const mergeResult = await gitAdapter.mergeTree(head.sha, snapshot.sha);
    return {
      kind: mergeResult.clean ? 'late-clean' : 'late-conflict',
      headSha,
      late: { sha: head.sha, subject: commitSubject(head), tree: head.tree },
      expectedTree: mergeResult.tree,
      remaining: [{ sha: head.sha, subject: commitSubject(head) }],
    };
  }

  if (head.parents.length === 2 && head.parents[1] === snapshot.sha) {
    const late = await readCommit(head.parents[0]);
    if (late.parents.length !== 1 || late.parents[0] !== merge.sha) {
      fail('normal reconciliation has multiple or unbound late commits');
    }
    if (await gitAdapter.isAncestor(late.sha, snapshot.sha)) fail('normal reconciliation late X is reachable from V');
    const mergeResult = await gitAdapter.mergeTree(late.sha, snapshot.sha);
    if (
      !mergeResult.clean ||
      mergeResult.tree !== head.tree ||
      head.message !== reconciliationMessage({ mergeSha: merge.sha, lateSha: late.sha, snapshotSha: snapshot.sha })
    ) {
      fail('normal reconciliation J has an incompatible tree, parent order, or deterministic message');
    }
    return {
      kind: 'normal-j',
      headSha,
      commit: head,
      late: { sha: late.sha, subject: commitSubject(late), tree: late.tree },
      remaining: [{ sha: late.sha, subject: commitSubject(late) }],
    };
  }

  if (head.parents.length === 2 && head.parents[0] === snapshot.sha && head.parents[1] === recoverySha) {
    const late = await readCommit(recoverySha);
    if (late.parents.length !== 1 || late.parents[0] !== merge.sha) fail('recovery merge has unbound late work');
    const mergeResult = await gitAdapter.mergeTree(snapshot.sha, late.sha);
    if (!mergeResult.clean || mergeResult.tree !== head.tree) fail('recovery merge has an incompatible tree');
    return {
      kind: 'recovery-j',
      headSha,
      commit: head,
      late: { sha: late.sha, subject: commitSubject(late), tree: late.tree },
      remaining: [{ sha: late.sha, subject: commitSubject(late) }],
    };
  }

  fail('release line is not exact M, V, one clean late X, normal J [X,V], or a bound recovery merge');
}

function matchingPulls(pulls, headRef, baseRef) {
  return pulls.filter((pull) => sameRepositorySide(pull.head, headRef) && sameRepositorySide(pull.base, baseRef));
}

function summarizeRefs(refs) {
  return Object.fromEntries(Object.entries(refs).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value.sha]));
}

function preservationFingerprint(refs, pulls, releases) {
  const value = {
    refs: summarizeRefs(refs),
    pulls: pulls.map((pull) => ({ number: pull.number, state: pull.state, draft: pull.draft, head: pull.head?.sha, base: pull.base?.sha, mergedAt: pull.merged_at })).sort((a, b) => a.number - b.number),
    releases: releases.map((release) => ({ id: release.id, tag: release.tag_name, draft: release.draft, prerelease: release.prerelease })).sort((a, b) => a.id - b.id),
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateAcceptedAuthority(authority, snapshotSha) {
  if (
    authority?.schemaVersion !== 1 ||
    authority.locator !== SNAPSHOT_REF ||
    authority.snapshot?.sha !== snapshotSha ||
    authority.snapshot?.parents?.length !== 1 ||
    authority.snapshot.parents[0] !== authority.merge?.sha ||
    authority.intent?.sha !== authority.stagedSha ||
    authority.source?.sha !== authority.sourceSha ||
    authority.merge?.sha !== authority.mergeSha ||
    authority.intent?.parents?.length !== 1 ||
    authority.intent.parents[0] !== authority.source?.sha ||
    authority.intent.tree !== authority.source.tree ||
    authority.merge?.parents?.length !== 2 ||
    authority.merge.parents[0] !== authority.source.sha ||
    authority.merge.parents[1] !== authority.intent.sha ||
    authority.merge.tree !== authority.source.tree ||
    authority.snapshot.tree === authority.merge.tree ||
    typeof authority.qa?.label !== 'string' ||
    !authority.qa.label
  ) {
    fail('accepted snapshot adapter returned an incomplete or incompatible authority record');
  }
  const roles = [authority.sourceSha, authority.stagedSha, authority.mergeSha, authority.snapshot.sha];
  roles.forEach((value, index) => assertSha(value, ['S', 'I', 'M', 'V'][index]));
  if (new Set(roles).size !== roles.length) fail('accepted snapshot graph roles must be distinct');
  validatePackageEvidence(authority.packages);
  return authority;
}

export async function observeDurableState({ gitAdapter, githubAdapter, npmAdapter, context }) {
  const [refs, repository, pulls, releases, npmObservations] = await Promise.all([
    gitAdapter.listRefs(),
    githubAdapter.repository(),
    githubAdapter.listPulls(),
    githubAdapter.listReleases(),
    Promise.all(PACKAGE_SPECS.map((spec) => npmAdapter.observe(spec))),
  ]);
  if (repository?.full_name !== REPOSITORY || repository.default_branch !== DEFAULT_BRANCH) {
    fail(`default repository must be exact ${REPOSITORY}@${DEFAULT_BRANCH}`);
  }
  assertUniqueNumbers(pulls, 'complete pull-request history');
  const mainSha = refSha(refs, `refs/heads/${DEFAULT_BRANCH}`);
  assertSha(mainSha, 'remote default main');
  if (context.enforceTrustedMain && (context.sourceSha !== mainSha || context.localSha !== mainSha)) {
    fail('finalizer source is not exact current default main');
  }

  const common = {
    context: { ...context, remoteMainSha: mainSha, permissions: FINALIZER_PERMISSIONS },
    refs,
    pulls,
    releases,
    preservationFingerprint: preservationFingerprint(refs, pulls, releases),
  };
  const snapshotSha = refSha(refs, SNAPSHOT_REF);
  if (snapshotSha === null) {
    if (
      refs[TAG_REF] ||
      releases.some((release) => release.tag_name === TAG_NAME) ||
      npmObservations.some((observation) => observation.status === 'present')
    ) {
      fail('PERMANENT STOP: public 1.0.1 state exists without the accepted V locator');
    }
    return { ...common, phase: 'await-snapshot', packages: { observations: npmObservations } };
  }
  assertSha(snapshotSha, 'snapshot V');

  const authority = validateAcceptedAuthority(await gitAdapter.acceptedSnapshot(snapshotSha), snapshotSha);
  const { source, intent, merge, snapshot } = authority;
  const commitCache = new Map([
    [source.sha, source],
    [intent.sha, intent],
    [merge.sha, merge],
    [snapshot.sha, snapshot],
  ]);
  const readCommit = async (sha) => {
    if (!commitCache.has(sha)) commitCache.set(sha, await gitAdapter.commit(sha));
    return commitCache.get(sha);
  };
  const expectedPackages = authority.packages.map((item, index) => ({ ...item, ...PACKAGE_SPECS[index] }));
  npmObservations.forEach((observation, index) => validateNpmObservation(observation, expectedPackages[index], PACKAGE_SPECS[index]));
  const packageStatuses = npmObservations.map(({ status }) => status);
  if (packageStatuses[0] === 'absent' && packageStatuses[1] === 'present') {
    fail('PERMANENT STOP: inverse npm partial exists (add-on present, core absent)');
  }
  const packagesComplete = packageStatuses.every((status) => status === 'present');
  const canonicalPartial = packageStatuses[0] === 'present' && packageStatuses[1] === 'absent';

  const releaseLineSha = refSha(refs, RELEASE_REF);
  assertSha(releaseLineSha, 'release line');
  const recoverySha = refSha(refs, RECOVERY_REF);
  if (recoverySha !== null) assertSha(recoverySha, 'recovery branch');
  const line = await deriveLine({ gitAdapter, readCommit, headSha: releaseLineSha, merge, snapshot, recoverySha });

  const releasePulls = pulls.filter((pull) =>
    sameRepositorySide(pull.base, RELEASE_LINE) &&
    sameRepositorySide(pull.head, STAGED_LINE) &&
    pull.head.sha === intent.sha &&
    pull.merge_commit_sha === merge.sha &&
    pullState(pull) === 'closed-merged');
  if (releasePulls.length !== 1) fail('accepted snapshot does not resolve to exactly one merged release PR');

  const recoveryPullHistory = matchingPulls(pulls, RECOVERY_LINE, RELEASE_LINE);
  let recovery = { kind: 'none' };
  if (recoverySha !== null) {
    const late = await readCommit(recoverySha);
    if (late.parents.length !== 1 || late.parents[0] !== merge.sha) fail('recovery branch does not preserve exactly one late commit over M');
    const conflict = await gitAdapter.mergeTree(late.sha, snapshot.sha);
    if (conflict.clean) fail('recovery state exists for work that does not genuinely conflict with V');
    if (recoveryPullHistory.length !== 1) fail('recovery branch must have exactly one recorded recovery PR');
    const pull = recoveryPullHistory[0];
    if (pull.head.sha !== late.sha || pull.draft !== true) fail('recovery PR does not preserve the exact late head as a draft');
    const state = pullState(pull);
    if (state === 'closed-unmerged') fail('recorded recovery PR is closed without merging');
    if (state === 'open' && line.kind !== 'version') fail('open recovery PR requires the release line to remain exact V');
    if (state === 'closed-merged' && line.kind !== 'recovery-j') fail('merged recovery PR requires an exact recovery merge on the line');
    recovery = { kind: 'recorded', branch: RECOVERY_LINE, sha: late.sha, pull: { number: pull.number, state, url: pull.html_url } };
  } else if (recoveryPullHistory.length !== 0) {
    fail('recovery PR history exists without its exact retained recovery branch');
  }
  if (!packagesComplete && recovery.kind !== 'none') {
    fail('recovery state exists before both public packages exactly match V');
  }

  const tagEntry = refs[TAG_REF] ?? null;
  let tag = { status: 'absent', name: TAG_NAME };
  if (tagEntry !== null) {
    if (tagEntry.type !== 'commit' || tagEntry.sha !== snapshot.sha) fail(`PERMANENT STOP: ${TAG_NAME} is not a lightweight tag at V`);
    tag = { status: 'present', name: TAG_NAME, targetSha: tagEntry.sha };
  }

  const matchingReleases = releases.filter((release) => release.tag_name === TAG_NAME);
  if (matchingReleases.length > 1) fail(`PERMANENT STOP: multiple GitHub Releases identify ${TAG_NAME}`);
  let githubRelease = { status: 'absent' };

  const baseState = {
    ...common,
    phase: 'observed',
    graph: { source, intent, merge, snapshot, authority, releasePull: { number: releasePulls[0].number, url: releasePulls[0].html_url } },
    packages: { expected: expectedPackages, observations: npmObservations, complete: packagesComplete, canonicalPartial },
    line,
    recovery,
    tag,
  };
  if (matchingReleases.length === 1) {
    const release = matchingReleases[0];
    const expectedBody = githubReleaseBody(baseState);
    if (
      tag.status !== 'present' ||
      release.draft !== false ||
      release.prerelease !== false ||
      release.name !== TAG_NAME ||
      release.target_commitish !== snapshot.sha ||
      release.body !== expectedBody ||
      !Number.isInteger(release.id) ||
      typeof release.html_url !== 'string'
    ) {
      fail(`PERMANENT STOP: existing GitHub Release for ${TAG_NAME} is incompatible`);
    }
    githubRelease = { status: 'present', id: release.id, url: release.html_url, tagName: TAG_NAME };
  }

  if ((tag.status === 'present' || githubRelease.status === 'present') && (!packagesComplete || !['version', 'normal-j', 'recovery-j'].includes(line.kind))) {
    fail('tag or GitHub Release exists before packages and release-line reconciliation are exact');
  }
  if (githubRelease.status === 'present' && tag.status !== 'present') fail('GitHub Release exists without the exact lightweight tag');
  if ((tag.status === 'present' || githubRelease.status === 'present') && recovery.kind !== 'none' && recovery.kind !== 'recorded') {
    fail('tag or GitHub Release coexists with unrecorded recovery state');
  }

  const stagedSha = refSha(refs, STAGED_REF);
  if (stagedSha === null) fail('staged/v1.0 is unexpectedly absent');
  assertSha(stagedSha, 'staged ref');
  let staged = { kind: 'sealed-intent', sha: stagedSha };
  if (stagedSha === intent.sha) {
    // Expected until the finalizer advances to the next proposal.
  } else {
    const stagedCommit = await readCommit(stagedSha);
    const lineCommit = await readCommit(line.headSha);
    validateNextIntent(stagedCommit, lineCommit);
    staged = { kind: 'next-intent', sha: stagedSha, commit: stagedCommit };
  }

  const currentProposalHistory = matchingPulls(pulls, STAGED_LINE, RELEASE_LINE)
    .filter((pull) => pull.head.sha === stagedSha && pull.merge_commit_sha !== merge.sha);
  let proposal = { kind: 'none', history: [] };
  if (staged.kind === 'next-intent') {
    const expectedTitle = nextProposalTitle();
    const expectedBody = nextProposalBody({ ...baseState, githubRelease, staged });
    const open = [];
    const history = [];
    for (const pull of currentProposalHistory) {
      const state = pullState(pull);
      if (state === 'closed-merged') fail('a 1.0.2 proposal is already merged during 1.0.1 finalization');
      if (pull.draft !== true) fail('a 1.0.2 proposal is not an exact draft');
      if (pull.title !== expectedTitle || pull.body !== expectedBody) fail('a 1.0.2 proposal has incompatible editable identity');
      const item = { number: pull.number, state, url: pull.html_url };
      history.push(item);
      if (state === 'open') open.push(item);
    }
    if (open.length > 1) fail('more than one open 1.0.2 proposal exists');
    proposal = open.length === 1 ? { kind: 'open', pull: open[0], history } : { kind: 'none', history };
  } else if (currentProposalHistory.length !== 0) {
    fail('next proposal history exists before the 1.0.2 intent is durable');
  }

  if (recovery.kind === 'recorded' && recovery.pull.state === 'open' && (staged.kind !== 'sealed-intent' || proposal.kind !== 'none')) {
    fail('a next proposal exists while the exact recovery PR is open');
  }
  if (line.remaining.length === 0 && staged.kind === 'next-intent') fail('a 1.0.2 intent exists without remaining unreleased work');
  if (staged.kind === 'next-intent' && githubRelease.status !== 'present') {
    fail('a 1.0.2 intent exists before the exact 1.0.1 GitHub Release');
  }

  return { ...baseState, githubRelease, staged, proposal };
}

export function classifyNextAction(state) {
  if (state.phase === 'await-snapshot') return { type: 'await-snapshot', durable: false };
  if (state.line.kind === 'late-conflict') {
    fail('REAL CONFLICT: stop and use the retained fablebookjs/infra#15 recovery proof; destructive recovery is not implemented here');
  }
  if (!state.packages.complete) {
    return { type: 'await-npm', durable: false, reason: state.packages.canonicalPartial ? 'core-present-addon-absent' : 'packages-absent' };
  }
  if (state.line.kind === 'merge') {
    return { type: 'fast-forward-line', durable: true, ref: RELEASE_REF, expected: state.graph.merge.sha, next: state.graph.snapshot.sha };
  }
  if (state.line.kind === 'late-clean') {
    return {
      type: 'create-reconciliation',
      durable: true,
      ref: RELEASE_REF,
      expected: state.line.late.sha,
      tree: state.line.expectedTree,
      parents: [state.line.late.sha, state.graph.snapshot.sha],
      message: reconciliationMessage({ mergeSha: state.graph.merge.sha, lateSha: state.line.late.sha, snapshotSha: state.graph.snapshot.sha }),
    };
  }
  if (state.tag.status === 'absent') {
    return { type: 'create-tag', durable: true, ref: TAG_REF, expected: null, next: state.graph.snapshot.sha };
  }
  if (state.githubRelease.status === 'absent') {
    return { type: 'create-github-release', durable: true, tagName: TAG_NAME, targetSha: state.graph.snapshot.sha, body: githubReleaseBody(state) };
  }
  if (state.recovery.kind === 'recorded' && state.recovery.pull.state === 'open') {
    return { type: 'wait-recovery', durable: false, pullNumber: state.recovery.pull.number };
  }
  if (state.line.remaining.length === 0) return { type: 'complete', durable: false };
  if (state.staged.kind === 'sealed-intent') {
    return {
      type: 'advance-staged-intent',
      durable: true,
      ref: STAGED_REF,
      expected: state.graph.intent.sha,
      tree: state.line.commit.tree,
      parents: [state.line.headSha],
      message: nextIntentMessage(state.line.headSha),
    };
  }
  if (state.proposal.kind === 'none') {
    return { type: 'create-next-proposal', durable: true, title: nextProposalTitle(), body: nextProposalBody(state) };
  }
  return { type: 'maintain-next-proposal', durable: false, pullNumber: state.proposal.pull.number };
}

export async function observeMaintainerPostMerge({ gitAdapter, releaseHeadSha, mergeSha, snapshotSha }) {
  for (const [value, label] of [
    [releaseHeadSha, 'maintainer-observed release head'],
    [mergeSha, 'maintainer-observed M'],
    [snapshotSha, 'maintainer-observed V'],
  ]) assertSha(value, label);
  if (new Set([releaseHeadSha, mergeSha, snapshotSha]).size !== 3) {
    fail('post-M observer roles must be distinct');
  }
  const [authority, head] = await Promise.all([
    gitAdapter.acceptedSnapshot(snapshotSha),
    gitAdapter.commit(releaseHeadSha),
  ]);
  validateAcceptedAuthority(authority, snapshotSha);
  if (
    authority?.schemaVersion !== 1 ||
    authority.locator !== SNAPSHOT_REF ||
    authority.mergeSha !== mergeSha ||
    authority.snapshot?.sha !== snapshotSha ||
    authority.snapshot?.parents?.length !== 1 ||
    authority.snapshot.parents[0] !== authority.merge?.sha ||
    authority.snapshot.tree === authority.merge.tree
  ) {
    fail('post-M observer did not receive the exact accepted V authority over M');
  }
  const { merge, snapshot } = authority;
  const common = {
    observer: 'issue-19-finalizer',
    schemaVersion: 1,
    line: RELEASE_LINE,
    version: RELEASE_VERSION,
    mergeSha: merge.sha,
    headSha: head.sha,
    snapshotSha: snapshot.sha,
  };
  if (head.parents.length === 1 && head.parents[0] === merge.sha) {
    if (await gitAdapter.isAncestor(head.sha, snapshot.sha)) fail('post-M late H is unexpectedly reachable from V');
    const mergeResult = await gitAdapter.mergeTree(head.sha, snapshot.sha);
    if (mergeResult.clean && !SHA.test(mergeResult.tree ?? '')) fail('post-M H,V clean merge has no exact tree');
    return { ...common, kind: 'late-head', verifiedMergeSha: merge.sha };
  }
  if (head.parents.length === 2 && head.parents[1] === snapshot.sha) {
    const late = await gitAdapter.commit(head.parents[0]);
    if (late.parents.length !== 1 || late.parents[0] !== merge.sha) {
      fail('post-M normal J has multiple or unbound late commits');
    }
    if (await gitAdapter.isAncestor(late.sha, snapshot.sha)) fail('post-M normal J late H is reachable from V');
    const mergeResult = await gitAdapter.mergeTree(late.sha, snapshot.sha);
    const expectedMessage = reconciliationMessage({ mergeSha: merge.sha, lateSha: late.sha, snapshotSha: snapshot.sha });
    if (!mergeResult.clean || mergeResult.tree !== head.tree || head.message !== expectedMessage) {
      fail('post-M normal J fails exact parents, merge-tree, or structured reconciliation metadata');
    }
    return {
      ...common,
      kind: 'normal-reconciliation',
      lateHeadSha: late.sha,
      expectedTreeSha: head.tree,
      metadata: {
        schemaVersion: 1,
        line: RELEASE_LINE,
        version: RELEASE_VERSION,
        mergeSha: merge.sha,
        snapshotSha: snapshot.sha,
        lateHeadSha: late.sha,
      },
    };
  }
  fail('post-M observer accepts only one exact late H over M or deterministic normal J [H,V]');
}

function changedRefs(before, after) {
  const names = new Set([...Object.keys(before.refs), ...Object.keys(after.refs)]);
  return [...names].sort().flatMap((name) => {
    const oldSha = refSha(before.refs, name);
    const newSha = refSha(after.refs, name);
    return oldSha === newSha ? [] : [{ name, oldSha, newSha }];
  });
}

function summarizeState(state) {
  if (state.phase === 'await-snapshot') return { phase: state.phase };
  return {
    pr: state.graph.releasePull,
    sourceSha: state.graph.source.sha,
    stagedSha: state.graph.intent.sha,
    mergeSha: state.graph.merge.sha,
    snapshotSha: state.graph.snapshot.sha,
    qa: state.graph.authority.qa,
    npm: state.packages.observations.map((item) => ({
      name: item.name,
      status: item.status,
      version: item.version,
      metadataIntegrity: item.metadataIntegrity,
      metadataShasum: item.metadataShasum,
      downloadedIntegrity: item.downloadedIntegrity,
      downloadedShasum: item.downloadedShasum,
      repository: item.repository,
      dependencies: item.dependencies,
    })),
    line: {
      kind: state.line.kind,
      headSha: state.line.headSha,
      lateSha: state.line.late?.sha ?? null,
      reconciliationSha: state.line.commit?.sha ?? null,
      remaining: state.line.remaining,
    },
    tag: state.tag,
    githubRelease: state.githubRelease,
    recovery: state.recovery,
    next: { staged: state.staged, proposal: state.proposal },
  };
}

function actionSatisfied(action, after, createdSha) {
  switch (action.type) {
    case 'fast-forward-line': return after.line.kind === 'version' && after.line.headSha === action.next;
    case 'create-reconciliation': return after.line.kind === 'normal-j' && after.line.headSha === createdSha;
    case 'create-tag': return after.tag.status === 'present' && after.tag.targetSha === action.next;
    case 'create-github-release': return after.githubRelease.status === 'present';
    case 'advance-staged-intent': return after.staged.kind === 'next-intent' && after.staged.sha === createdSha;
    case 'create-next-proposal': return after.proposal.kind === 'open';
    default: return true;
  }
}

export async function runFinalizerInvocation({ adapters, context, fault = 'none' }) {
  if (!FAULTS.includes(fault)) fail(`fault must be one of ${FAULTS.join(', ')}`);
  const before = await observeDurableState({ ...adapters, context });
  const action = classifyNextAction(before);
  let after = before;
  let result = action.durable ? 'attempted' : 'no-op';
  let createdSha = null;
  let writeError = null;

  if (action.type === 'fast-forward-line' || action.type === 'create-tag') {
    try {
      await adapters.gitAdapter.pushRef(action.ref, action.expected, action.next);
    } catch (error) {
      writeError = error;
    }
  } else if (action.type === 'create-reconciliation' || action.type === 'advance-staged-intent') {
    createdSha = await adapters.gitAdapter.createCommit({ tree: action.tree, parents: action.parents, message: action.message, identity: FINALIZER_IDENTITY });
    assertSha(createdSha, 'deterministic commit');
    try {
      await adapters.gitAdapter.pushRef(action.ref, action.expected, createdSha);
    } catch (error) {
      writeError = error;
    }
  } else if (action.type === 'create-github-release') {
    try {
      await adapters.githubAdapter.createRelease({ tagName: action.tagName, targetSha: action.targetSha, body: action.body });
    } catch (error) {
      writeError = error;
    }
  } else if (action.type === 'create-next-proposal') {
    try {
      await adapters.githubAdapter.createPullRequest({ title: action.title, body: action.body, head: STAGED_LINE, base: RELEASE_LINE, draft: true });
    } catch (error) {
      writeError = error;
    }
  }

  if (action.durable) {
    after = await observeDurableState({ ...adapters, context });
    if (actionSatisfied(action, after, createdSha)) {
      result = writeError ? 'converged-after-ambiguous-response' : 'performed-and-verified';
    } else if (writeError && ['fast-forward-line', 'create-reconciliation', 'advance-staged-intent'].includes(action.type)) {
      result = 'stale-ref-rejected-and-refetched';
    } else {
      throw writeError ?? new Error(`durable action ${action.type} did not pass exact post-read`);
    }
  }

  const evidence = {
    schemaVersion: 1,
    operation: 'finalize-release',
    repository: REPOSITORY,
    context: before.context,
    before: summarizeState(before),
    action: { ...action, result, createdSha },
    after: summarizeState(after),
    preservation: {
      beforeFingerprint: before.preservationFingerprint,
      afterFingerprint: after.preservationFingerprint,
      changedRefs: changedRefs(before, after),
      storybookMutation: false,
      npmMutation: false,
    },
  };

  if (action.type === 'create-github-release' && fault === 'after-github-release-post' && after.githubRelease.status === 'present') {
    const error = new Error('INJECTED FAULT: GitHub Release is durable; stop before success report');
    error.evidence = evidence;
    throw error;
  }
  return evidence;
}

function runGit(args, { cwd = process.cwd(), input, env = {}, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, LC_ALL: 'C', ...env },
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git operation failed (${result.status})`);
  }
  return result;
}

export class LiveGitAdapter {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
  }

  async listRefs() {
    const hostile = Object.keys(process.env).filter((key) => HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)));
    if (hostile.length > 0) fail(`hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    assertSafeGitConfiguration(this.cwd);
    runGit(['fetch', '--force', '--prune', '--prune-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'], { cwd: this.cwd });
    const output = runGit(['ls-remote', '--refs', 'origin'], { cwd: this.cwd }).stdout.trim();
    const refs = {};
    for (const row of output.split('\n').filter(Boolean)) {
      const [sha, name] = row.split(/\s+/);
      assertSha(sha, `remote ${name}`);
      if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) continue;
      if (refs[name]) fail(`remote ref ${name} is ambiguous`);
      let type = 'commit';
      if (name.startsWith('refs/tags/')) type = runGit(['cat-file', '-t', sha], { cwd: this.cwd }).stdout.trim();
      refs[name] = { sha, type };
    }
    return refs;
  }

  commit(sha) {
    return commitShape(this.cwd, sha);
  }

  async acceptedSnapshot(snapshotSha) {
    const snapshot = this.commit(snapshotSha);
    const metadata = parseSnapshotMessage(snapshot.message);
    for (const [value, label] of [[metadata.mergeSha, 'M'], [metadata.stagedSha, 'I'], [metadata.sourceSha, 'S']]) {
      assertSha(value, label);
    }
    const merge = this.commit(metadata.mergeSha);
    const intent = this.commit(metadata.stagedSha);
    const source = this.commit(metadata.sourceSha);
    intent.sourceTree = source.tree;
    validateIntentShape(intent, source.sha);
    validateMergeShape(merge, source, intent);
    validateSnapshotShape(snapshot, metadata, merge);
    const changedPaths = await this.diffPaths(merge.sha, snapshot.sha);
    if (JSON.stringify([...changedPaths].sort()) !== JSON.stringify([...TRANSFORMED_FILES].sort())) {
      fail('V does not contain the exact accepted four-file version transform');
    }
    const [coreManifest, addonManifest] = await Promise.all([
      this.jsonAt(snapshot.sha, PACKAGE_SPECS[0].directory + '/package.json'),
      this.jsonAt(snapshot.sha, PACKAGE_SPECS[1].directory + '/package.json'),
    ]);
    for (const [manifest, spec] of [[coreManifest, PACKAGE_SPECS[0]], [addonManifest, PACKAGE_SPECS[1]]]) {
      if (manifest.name !== spec.name || manifest.version !== RELEASE_VERSION || !exactRepository(manifest.repository, spec.directory)) {
        fail(`V contains an incompatible ${spec.name} manifest identity`);
      }
    }
    if (addonManifest.dependencies?.[PACKAGE_SPECS[0].name] !== RELEASE_VERSION || Object.keys(addonManifest.dependencies ?? {}).length !== 1) {
      fail(`V add-on manifest does not depend exactly on core ${RELEASE_VERSION}`);
    }
    return {
      schemaVersion: 1,
      locator: SNAPSHOT_REF,
      sourceSha: source.sha,
      stagedSha: intent.sha,
      mergeSha: merge.sha,
      source,
      intent,
      merge,
      snapshot,
      packages: metadata.packages,
      qa: { kind: 'ready-release-qa-run', runId: metadata.qaRunId, label: `ready-release-qa-run:${metadata.qaRunId}` },
    };
  }

  diffPaths(from, to) {
    return runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', from, to], { cwd: this.cwd }).stdout.trim().split('\n').filter(Boolean);
  }

  jsonAt(sha, path) {
    return JSON.parse(runGit(['show', `${sha}:${path}`], { cwd: this.cwd }).stdout);
  }

  isAncestor(ancestor, descendant) {
    const result = runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.cwd, allowFailure: true });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    fail('git could not determine commit ancestry');
  }

  mergeTree(first, second) {
    const result = runGit(['merge-tree', '--write-tree', first, second], { cwd: this.cwd, allowFailure: true });
    if (result.status === 1) return { clean: false, tree: null };
    if (result.status !== 0) fail('git merge-tree failed unexpectedly');
    const tree = result.stdout.trim().split('\n')[0];
    assertSha(tree, 'merge tree');
    return { clean: true, tree };
  }

  createCommit({ tree, parents, message, identity }) {
    const args = ['commit-tree', tree];
    for (const parent of parents) args.push('-p', parent);
    const env = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_AUTHOR_DATE: identity.date,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_DATE: identity.date,
    };
    return runGit(args, { cwd: this.cwd, input: message, env }).stdout.trim();
  }

  pushRef(ref, expected, next) {
    const hostile = Object.keys(process.env).filter((key) => HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)));
    if (hostile.length > 0) fail(`hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    if (![RELEASE_REF, STAGED_REF, TAG_REF].includes(ref)) fail(`finalizer refuses write outside its three exact refs: ${ref}`);
    if (expected !== null) assertSha(expected, 'expected old ref');
    assertSha(next, 'next ref');
    const result = runGit([
      'push', '--porcelain', `--force-with-lease=${ref}:${expected ?? ''}`, 'origin', `${next}:${ref}`,
    ], { cwd: this.cwd, allowFailure: true });
    if (result.status !== 0) throw new Error(`guarded ref write for ${ref} was rejected`);
  }
}

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is required for finalizer GitHub authority');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export class LiveGitHubAdapter {
  async request(method, path, body) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { ...githubHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed with ${response.status}`);
    return { value, link: response.headers.get('link') };
  }

  async paginate(path) {
    const items = [];
    const seen = new Set();
    let firstPageKeys = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const { value } = await this.request('GET', `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(value)) fail(`GitHub pagination for ${path} did not return an array`);
      const keys = value.map((item) => item.number ?? item.id);
      if (keys.some((key) => !Number.isInteger(key))) fail(`GitHub pagination for ${path} returned an item without a stable identity`);
      if (page === 1) firstPageKeys = keys;
      for (let index = 0; index < value.length; index += 1) {
        if (seen.has(keys[index])) fail(`GitHub pagination for ${path} returned a duplicate identity`);
        seen.add(keys[index]);
        items.push(value[index]);
      }
      if (value.length < PAGE_SIZE) {
        const { value: repeatedFirst } = await this.request('GET', `${path}${separator}per_page=${PAGE_SIZE}&page=1`);
        if (!Array.isArray(repeatedFirst) || JSON.stringify(repeatedFirst.map((item) => item.number ?? item.id)) !== JSON.stringify(firstPageKeys)) {
          fail(`GitHub pagination for ${path} changed while reading complete history`);
        }
        return items;
      }
    }
    fail(`GitHub pagination for ${path} exceeded ${MAX_PAGES} pages`);
  }

  async repository() {
    return (await this.request('GET', `/repos/${REPOSITORY}`)).value;
  }

  listPulls() {
    return this.paginate(`/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc`);
  }

  listReleases() {
    return this.paginate(`/repos/${REPOSITORY}/releases`);
  }

  async createRelease({ tagName, targetSha, body }) {
    return (await this.request('POST', `/repos/${REPOSITORY}/releases`, {
      tag_name: tagName,
      target_commitish: targetSha,
      name: tagName,
      body,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    })).value;
  }

  async createPullRequest({ title, body, head, base, draft }) {
    return (await this.request('POST', `/repos/${REPOSITORY}/pulls`, { title, body, head, base, draft })).value;
  }
}

export class LiveNpmAdapter {
  async observe(spec) {
    const metadataUrl = new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, REGISTRY);
    const response = await fetch(metadataUrl, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return { status: 'absent', name: spec.name };
    if (!response.ok) fail(`npm metadata read for ${spec.name} failed with ${response.status}`);
    const metadata = await response.json();
    if (typeof metadata.dist?.tarball !== 'string') fail(`npm metadata for ${spec.name} lacks a tarball URL`);
    const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
    const expectedUrl = new URL(`/${spec.name}/-/${archiveName}`, REGISTRY);
    const tarballUrl = new URL(metadata.dist.tarball);
    if (tarballUrl.href !== expectedUrl.href) fail(`PERMANENT STOP: npm ${spec.name} tarball URL is incompatible`);
    const archive = await fetch(tarballUrl);
    if (!archive.ok) fail(`npm tarball read for ${spec.name} failed with ${archive.status}`);
    const bytes = Buffer.from(await archive.arrayBuffer());
    return {
      status: 'present',
      name: metadata.name,
      version: metadata.version,
      repository: metadata.repository,
      dependencies: metadata.dependencies ?? {},
      metadataIntegrity: metadata.dist.integrity,
      metadataShasum: metadata.dist.shasum,
      downloadedIntegrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      downloadedShasum: createHash('sha1').update(bytes).digest('hex'),
      tarball: tarballUrl.href,
    };
  }
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || key.slice(2) in values) fail('arguments must be unique --key value pairs');
    values[key.slice(2)] = value;
  }
  for (const key of ['repository', 'fault', 'evidence']) if (!values[key]) fail(`missing --${key}`);
  if (values.repository !== REPOSITORY) fail(`refusing finalization outside ${REPOSITORY}`);
  if (!FAULTS.includes(values.fault)) fail(`unsupported fault ${values.fault}`);
  return values;
}

function liveContext(repoRoot) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== REPOSITORY ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== `refs/heads/${DEFAULT_BRANCH}` ||
    !process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/finalize-release.yml@refs/heads/main')
  ) {
    fail('finalizer requires exact workflow_dispatch authority from current default main');
  }
  const localSha = git(repoRoot, 'rev-parse', 'HEAD');
  if (process.env.GITHUB_SHA !== localSha) fail('GITHUB_SHA does not equal checked-out trusted main');
  return {
    enforceTrustedMain: true,
    actor: process.env.GITHUB_ACTOR,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    event: process.env.GITHUB_EVENT_NAME,
    runId: process.env.GITHUB_RUN_ID,
    sourceSha: process.env.GITHUB_SHA,
    localSha,
  };
}

function failureEvidence(error, evidence) {
  return {
    schemaVersion: 1,
    operation: 'finalize-release',
    repository: REPOSITORY,
    outcome: 'failed-closed',
    error: { message: String(error.message).slice(0, 800) },
    durableEvidence: evidence ?? null,
    safety: { storybookMutation: false, npmMutation: false, rawDiagnostics: false },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
    const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
    if (git(repoRoot, 'status', '--porcelain') !== '') fail('finalizer requires a clean trusted-main checkout');
    const evidence = await runFinalizerInvocation({
      adapters: {
        gitAdapter: new LiveGitAdapter({ cwd: repoRoot }),
        githubAdapter: new LiveGitHubAdapter(),
        npmAdapter: new LiveNpmAdapter(),
      },
      context: liveContext(repoRoot),
      fault: args.fault,
    });
    writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ action: evidence.action.type, result: evidence.action.result })}\n`);
  } catch (error) {
    if (args?.evidence) {
      writeFileSync(args.evidence, `${JSON.stringify(failureEvidence(error, error.evidence), null, 2)}\n`, { mode: 0o600 });
    }
    console.error(String(error.message).slice(0, 800));
    process.exitCode = 1;
  }
}
