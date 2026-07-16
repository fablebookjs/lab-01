import { spawnSync } from 'node:child_process';
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
  assertSha,
  deriveTrustedSnapshotAuthority,
  fail,
  parseTrailers,
  validatePackageEvidence,
} from './release-publication.mjs';

export const DEFAULT_BRANCH = 'main';
export const RELEASE_REF = `refs/heads/${RELEASE_LINE}`;
export const STAGED_REF = `refs/heads/${STAGED_LINE}`;
export const RECOVERY_LINE = 'recovery/v1.0/1.0.1';
export const RECOVERY_REF = `refs/heads/${RECOVERY_LINE}`;
export const TAG_NAME = 'v1.0.1';
export const TAG_REF = `refs/tags/${TAG_NAME}`;
export const RELEASE_ATTEMPT_REF = 'refs/heads/finalizer-attempts/v1.0.1/github-release';
export const PROPOSAL_ATTEMPT_REF = 'refs/heads/finalizer-attempts/v1.0.2/next-proposal';
export const NEXT_VERSION = '1.0.2';
export const FAULTS = Object.freeze(['none', 'after-github-release-post']);
export const FINALIZER_PERMISSIONS = Object.freeze({ contents: 'write', pullRequests: 'write' });

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const HOSTILE_GIT_ENVIRONMENT = [
  /^GIT_ALTERNATE_OBJECT_DIRECTORIES$/,
  /^GIT_CEILING_DIRECTORIES$/,
  /^GIT_COMMON_DIR$/,
  /^GIT_CONFIG$/,
  /^GIT_CONFIG_COUNT$/,
  /^GIT_CONFIG_GLOBAL$/,
  /^GIT_CONFIG_KEY_\d+$/,
  /^GIT_CONFIG_NOSYSTEM$/,
  /^GIT_CONFIG_PARAMETERS$/,
  /^GIT_CONFIG_SYSTEM$/,
  /^GIT_CONFIG_VALUE_\d+$/,
  /^GIT_DIR$/,
  /^GIT_DISCOVERY_ACROSS_FILESYSTEM$/,
  /^GIT_EXEC_PATH$/,
  /^GIT_GRAFT_FILE$/,
  /^GIT_ASKPASS$/,
  /^GIT_CREDENTIAL_/,
  /^GIT_HTTP_PROXY_AUTHMETHOD$/,
  /^GIT_INDEX_FILE$/,
  /^GIT_NAMESPACE$/,
  /^GIT_OBJECT_DIRECTORY$/,
  /^GIT_PROXY_COMMAND$/,
  /^GIT_REPLACE_REF_BASE$/,
  /^GIT_SHALLOW_FILE$/,
  /^GIT_SSL_/,
  /^GIT_SSH(?:_COMMAND|_VARIANT)?$/,
  /^GIT_TERMINAL_PROMPT$/,
  /^GIT_WORK_TREE$/,
  /^SSH_ASKPASS(?:_REQUIRE)?$/,
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^CURL_CA_BUNDLE$/,
];
const HOSTILE_HTTP_ENVIRONMENT = [
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^NODE_USE_ENV_PROXY$/,
  /^NODE_EXTRA_CA_CERTS$/,
  /^NODE_TLS_REJECT_UNAUTHORIZED$/,
  /^GLOBAL_AGENT_/,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^(?:CURL|REQUESTS|AWS)_CA_BUNDLE$/,
];
const ALLOWED_GIT_WRITE_REFS = new Set([
  RELEASE_REF,
  STAGED_REF,
  TAG_REF,
  RELEASE_ATTEMPT_REF,
  PROPOSAL_ATTEMPT_REF,
]);
const LIVE_REMOTE_URLS = new Set([
  'https://github.com/fablebookjs/lab-01',
  'https://github.com/fablebookjs/lab-01.git',
]);
const FINALIZER_IDENTITY = Object.freeze({
  name: 'Fablebook Lab Finalizer',
  email: 'lab-finalizer@fablebook.invalid',
  date: '2026-07-16T00:00:00Z',
});

export class StaleLeaseError extends Error {
  constructor(ref) {
    super(`exact stale lease rejected ${ref}`);
    this.name = 'StaleLeaseError';
    this.ref = ref;
  }
}

export class DefiniteGitHubClientError extends Error {
  constructor(status, operation) {
    super(`GitHub definitely rejected ${operation} before creation (${status})`);
    this.name = 'DefiniteGitHubClientError';
    this.status = status;
    this.operation = operation;
  }
}

export class PrePostDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrePostDriftError';
  }
}

export function buildLeasedPushArguments(ref, expected, next) {
  if (!ALLOWED_GIT_WRITE_REFS.has(ref)) fail(`finalizer refuses write outside its exact ref allowlist: ${ref}`);
  if (expected !== null) assertSha(expected, 'expected old ref');
  assertSha(next, 'next ref');
  return [
    'push', '--porcelain', '--no-follow-tags',
    `--force-with-lease=${ref}:${expected ?? ''}`,
    'origin', `${next}:${ref}`,
  ];
}

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
  if (pull.state === 'open' && pull.merged === false && pull.merged_at === null) return 'open';
  if (pull.state === 'closed' && pull.merged === false && pull.merged_at === null) return 'closed-unmerged';
  if (pull.state === 'closed' && pull.merged === true && typeof pull.merged_at === 'string' && pull.merged_at) return 'closed-merged';
  fail(`pull request #${pull.number ?? 'unknown'} has a contradictory state tuple`);
}

function validateCanonicalPull(pull) {
  if (!Number.isInteger(pull?.number) || pull.number < 1) fail('pull request number is not positive');
  if (pull.id !== undefined && (!Number.isInteger(pull.id) || pull.id < 1)) fail(`pull request #${pull.number} has an invalid id`);
  if (pull.html_url !== `https://github.com/${REPOSITORY}/pull/${pull.number}`) {
    fail(`pull request #${pull.number} has a non-canonical URL`);
  }
  if (typeof pull.draft !== 'boolean' || typeof pull.merged !== 'boolean') {
    fail(`pull request #${pull.number} lacks exact draft/merged fields`);
  }
  for (const [side, label] of [[pull.base, 'base'], [pull.head, 'head']]) {
    if (
      typeof side?.ref !== 'string' || !side.ref ||
      !SHA.test(side.sha ?? '') ||
      typeof side.repo?.full_name !== 'string' || !side.repo.full_name
    ) {
      fail(`pull request #${pull.number} has an incomplete ${label} tuple`);
    }
  }
  if (typeof pull.title !== 'string' || (pull.body !== null && typeof pull.body !== 'string')) {
    fail(`pull request #${pull.number} lacks exact editable fields`);
  }
  const state = pullState(pull);
  if (state === 'closed-merged' && !SHA.test(pull.merge_commit_sha ?? '')) {
    fail(`merged pull request #${pull.number} lacks an exact merge commit`);
  }
  if (pull.merge_commit_sha !== null && !SHA.test(pull.merge_commit_sha ?? '')) {
    fail(`pull request #${pull.number} has a malformed merge commit field`);
  }
  return pull;
}

function validateCanonicalRelease(release) {
  if (!Number.isInteger(release?.id) || release.id < 1) fail('GitHub Release id is not positive');
  if (typeof release.tag_name !== 'string' || !release.tag_name) fail('GitHub Release lacks a tag');
  if (release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`) {
    fail(`GitHub Release ${release.id} has a non-canonical URL`);
  }
  if (
    typeof release.draft !== 'boolean' ||
    typeof release.prerelease !== 'boolean' ||
    typeof release.name !== 'string' ||
    (release.body !== null && typeof release.body !== 'string') ||
    typeof release.target_commitish !== 'string'
  ) {
    fail(`GitHub Release ${release.id} has an incomplete authoritative tuple`);
  }
  return release;
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

export function recoveryPullTitle() {
  return `Recover releases/v1.0 work after ${TAG_NAME}`;
}

export function recoveryPullBody({ lateSha, snapshotSha }) {
  return `## Recover work excluded from ${TAG_NAME}\n\n` +
    `- Complete displaced head H: \`${lateSha}\`\n` +
    `- Published snapshot V: \`${snapshotSha}\`\n` +
    `- This work was not part of ${TAG_NAME} and requires a later patch.\n` +
    `- Resolve the recorded conflict, mark this draft ready, and merge it normally.\n\n` +
    `The exact retained recovery branch and this pull request are the durable issue #15 recovery record.`;
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

async function structuredLifecycleIntent(pull, gitAdapter, readCommit) {
  const commit = typeof gitAdapter.pullCommit === 'function'
    ? await gitAdapter.pullCommit(pull.number, pull.head.sha)
    : await readCommit(pull.head.sha);
  if (commit.sha !== pull.head.sha || commit.parents.length !== 1) {
    fail(`pull request #${pull.number} does not resolve to one exact lifecycle intent`);
  }
  const match = /^release: propose v(1\.0\.[12])$/.exec(commit.message.split('\n', 1)[0]);
  if (!match) fail(`pull request #${pull.number} has an unstructured production lifecycle intent`);
  const version = match[1];
  const source = await readCommit(commit.parents[0]);
  if (commit.tree !== source.tree) fail(`pull request #${pull.number} lifecycle intent is not empty`);
  const trailers = parseTrailers(commit.message, `release: propose v${version}`);
  const expected = new Map([
    ['Release-Intent-Version', '1'],
    ['Release-Line', RELEASE_LINE],
    ['Release-Version', version],
    ['Release-Source', source.sha],
  ]);
  if (trailers.size !== expected.size) fail(`pull request #${pull.number} lifecycle intent has unexpected trailers`);
  for (const [key, value] of expected) {
    if (trailers.get(key) !== value) fail(`pull request #${pull.number} lifecycle intent has an invalid ${key}`);
  }
  if (pull.base.sha !== source.sha || pull.title !== `release: propose v${version}`) {
    fail(`pull request #${pull.number} lifecycle source/title is incompatible`);
  }
  return { version, sourceSha: source.sha, intentSha: commit.sha };
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
    return {
      kind: 'recovery-j-candidate',
      headSha,
      commit: head,
      late: { sha: late.sha, subject: commitSubject(late), tree: late.tree },
      remaining: [{ sha: late.sha, subject: commitSubject(late) }],
    };
  }

  fail('release line is not exact M, V, one clean late X, normal J [X,V], or a bound recovery J [V,H]');
}

function matchingPulls(pulls, headRef, baseRef) {
  return pulls.filter((pull) => sameRepositorySide(pull.head, headRef) && sameRepositorySide(pull.base, baseRef));
}

function summarizeRefs(refs) {
  return Object.entries(refs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, sha: value.sha, type: value.type }));
}

function canonicalPullTuple(pull) {
  validateCanonicalPull(pull);
  return {
    id: pull.id ?? null,
    number: pull.number,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeCommitSha: pull.merge_commit_sha,
    title: pull.title,
    body: pull.body,
    head: { repository: pull.head.repo.full_name, ref: pull.head.ref, sha: pull.head.sha },
    base: { repository: pull.base.repo.full_name, ref: pull.base.ref, sha: pull.base.sha },
  };
}

function canonicalReleaseTuple(release) {
  validateCanonicalRelease(release);
  return {
    id: release.id,
    url: release.html_url,
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
  };
}

function canonicalNpmTuple(observation) {
  return {
    name: observation.name,
    status: observation.status,
    version: observation.version ?? null,
    repository: observation.repository ?? null,
    dependencies: observation.dependencies ?? null,
    metadataIntegrity: observation.metadataIntegrity ?? null,
    metadataShasum: observation.metadataShasum ?? null,
    downloadedIntegrity: observation.downloadedIntegrity ?? null,
    downloadedShasum: observation.downloadedShasum ?? null,
  };
}

function authoritativeObservation(refs, pulls, releases, npmObservations) {
  return {
    refs: summarizeRefs(refs),
    pulls: pulls.map(canonicalPullTuple).sort((a, b) => a.number - b.number),
    releases: releases.map(canonicalReleaseTuple).sort((a, b) => a.id - b.id),
    packages: npmObservations.map(canonicalNpmTuple),
  };
}

function observationFingerprint(observation) {
  return createHash('sha256').update(JSON.stringify(observation)).digest('hex');
}

function markerState(observed, { authorized, spent, rejected, label }) {
  if (observed === null) return { phase: 'absent', ref: label };
  if (observed === authorized) return { phase: 'authorized', ref: label, sha: observed };
  if (observed === spent) return { phase: 'spent', ref: label, sha: observed };
  if (observed === rejected) return { phase: 'rejected', ref: label, sha: observed };
  fail(`${label} has incompatible attempt state ${observed}`);
}

function assertSameRefs(before, after, label) {
  if (JSON.stringify(summarizeRefs(before)) !== JSON.stringify(summarizeRefs(after))) {
    fail(`${label} changed while deriving finalizer authority`);
  }
}

function validateAcceptedAuthority(authority, snapshotSha) {
  if (
    authority?.schemaVersion !== 2 ||
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
    authority.treeSha !== authority.snapshot.tree ||
    !SHA256.test(authority.contentSha256 ?? '') ||
    authority.qa?.kind !== 'accepted-snapshot-content' ||
    authority.qa?.treeSha !== authority.treeSha ||
    authority.qa?.contentSha256 !== authority.contentSha256 ||
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
  if (typeof gitAdapter.preflight === 'function') await gitAdapter.preflight();
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
  pulls.forEach(validateCanonicalPull);
  releases.forEach(validateCanonicalRelease);
  assertUniqueNumbers(pulls, 'complete pull-request history');
  const mainSha = refSha(refs, `refs/heads/${DEFAULT_BRANCH}`);
  assertSha(mainSha, 'remote default main');
  if (context.enforceTrustedMain && (context.sourceSha !== mainSha || context.localSha !== mainSha)) {
    fail('finalizer source is not exact current default main');
  }

  const observed = authoritativeObservation(refs, pulls, releases, npmObservations);
  const common = {
    context: { ...context, remoteMainSha: mainSha, permissions: FINALIZER_PERMISSIONS },
    refs,
    pulls,
    releases,
    authoritativeObservation: observed,
    preservationFingerprint: observationFingerprint(observed),
  };
  const stableReturn = async (state) => {
    const finalRefs = await gitAdapter.listRefs();
    assertSameRefs(refs, finalRefs, 'stable remote refs');
    if (context.enforceTrustedMain) await gitAdapter.assertTrustedMain(context, finalRefs);
    return { ...state, stableRefsAfter: finalRefs };
  };
  const snapshotSha = refSha(refs, SNAPSHOT_REF);
  if (snapshotSha === null) {
    if (
      refs[TAG_REF] ||
      refs[RELEASE_ATTEMPT_REF] ||
      refs[PROPOSAL_ATTEMPT_REF] ||
      releases.some((release) => release.tag_name === TAG_NAME) ||
      npmObservations.some((observation) => observation.status === 'present')
    ) {
      fail('PERMANENT STOP: public 1.0.1 state exists without the accepted V locator');
    }
    return stableReturn({ ...common, phase: 'await-snapshot', packages: { observations: npmObservations } });
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
  let line = await deriveLine({ gitAdapter, readCommit, headSha: releaseLineSha, merge, snapshot, recoverySha });

  const releasePulls = pulls.filter((pull) =>
    sameRepositorySide(pull.base, RELEASE_LINE) &&
    sameRepositorySide(pull.head, STAGED_LINE) &&
    pull.base.sha === source.sha &&
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
    if (
      pull.head.sha !== late.sha ||
      pull.base.sha !== snapshot.sha ||
      pull.title !== recoveryPullTitle() ||
      pull.body !== recoveryPullBody({ lateSha: late.sha, snapshotSha: snapshot.sha })
    ) fail('recovery PR does not have the exact same-repository H/V identity');
    const state = pullState(pull);
    if (state === 'closed-unmerged') fail('recorded recovery PR is closed without merging');
    if (state === 'open') {
      if (pull.draft !== true || line.kind !== 'version') fail('open recovery PR requires draft=true and the release line at exact V');
    } else {
      if (
        pull.draft !== false ||
        line.kind !== 'recovery-j-candidate' ||
        pull.merge_commit_sha !== line.headSha
      ) fail('merged recovery PR does not bind exact current recovery J [V,H]');
      line = { ...line, kind: 'recovery-j' };
    }
    recovery = {
      kind: 'recorded',
      branch: RECOVERY_LINE,
      sha: late.sha,
      pull: { number: pull.number, state, url: pull.html_url, mergeCommitSha: pull.merge_commit_sha },
    };
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

  const releaseAttempt = markerState(refSha(refs, RELEASE_ATTEMPT_REF), {
    authorized: merge.sha,
    spent: snapshot.sha,
    rejected: intent.sha,
    label: RELEASE_ATTEMPT_REF,
  });
  if (tag.status === 'absent' && releaseAttempt.phase !== 'absent') {
    fail('GitHub Release attempt state exists before the exact lightweight tag');
  }
  if (githubRelease.status === 'present' && releaseAttempt.phase !== 'spent') {
    fail('exact GitHub Release lacks a consumed durable attempt authorization');
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

  const productionLifecycleHistory = matchingPulls(pulls, STAGED_LINE, RELEASE_LINE)
    .filter((pull) => pull.number !== releasePulls[0].number);
  const historicalReleasePulls = [];
  const currentProposalHistory = [];
  for (const pull of productionLifecycleHistory) {
    const lifecycle = await structuredLifecycleIntent(pull, gitAdapter, readCommit);
    const state = pullState(pull);
    if (lifecycle.version === RELEASE_VERSION) {
      if (state !== 'closed-unmerged') {
        fail(`historical ${RELEASE_VERSION} pull request #${pull.number} is not safely closed-unmerged`);
      }
      historicalReleasePulls.push({ number: pull.number, state, url: pull.html_url, ...lifecycle });
    } else if (lifecycle.version === NEXT_VERSION) {
      currentProposalHistory.push(pull);
    } else {
      fail(`pull request #${pull.number} identifies an unsupported lifecycle version`);
    }
  }
  let proposal = { kind: 'none', history: [] };
  let proposalAttempt = { phase: 'absent', ref: PROPOSAL_ATTEMPT_REF };
  if (staged.kind === 'next-intent') {
    const expectedTitle = nextProposalTitle();
    const expectedBody = nextProposalBody({ ...baseState, githubRelease, staged });
    const open = [];
    const history = [];
    for (const pull of currentProposalHistory) {
      const state = pullState(pull);
      if (state === 'closed-merged') fail('a 1.0.2 proposal is already merged during 1.0.1 finalization');
      if (
        pull.draft !== true ||
        pull.head.sha !== stagedSha ||
        pull.base.sha !== line.headSha ||
        pull.title !== expectedTitle ||
        pull.body !== expectedBody
      ) fail('a 1.0.2 proposal has incompatible head/base/editable identity');
      const item = { number: pull.number, state, url: pull.html_url, headSha: pull.head.sha, baseSha: pull.base.sha };
      history.push(item);
      if (state === 'open') open.push(item);
    }
    if (open.length > 1) fail('more than one open 1.0.2 proposal exists');
    proposal = open.length === 1 ? { kind: 'open', pull: open[0], history } : { kind: 'none', history };
    proposalAttempt = markerState(refSha(refs, PROPOSAL_ATTEMPT_REF), {
      authorized: line.headSha,
      spent: staged.sha,
      rejected: snapshot.sha,
      label: PROPOSAL_ATTEMPT_REF,
    });
    if (proposal.kind === 'open' && proposalAttempt.phase !== 'spent') {
      fail('open next proposal lacks a consumed durable attempt authorization');
    }
  } else if (currentProposalHistory.length !== 0) {
    fail('next proposal history exists before the 1.0.2 intent is durable');
  } else if (refSha(refs, PROPOSAL_ATTEMPT_REF) !== null) {
    fail('next-proposal attempt state exists before the exact 1.0.2 intent');
  }

  if (recovery.kind === 'recorded' && recovery.pull.state === 'open' && (staged.kind !== 'sealed-intent' || proposal.kind !== 'none')) {
    fail('a next proposal exists while the exact recovery PR is open');
  }
  if (line.remaining.length === 0 && staged.kind === 'next-intent') fail('a 1.0.2 intent exists without remaining unreleased work');
  if (staged.kind === 'next-intent' && githubRelease.status !== 'present') {
    fail('a 1.0.2 intent exists before the exact 1.0.1 GitHub Release');
  }

  return stableReturn({
    ...baseState,
    githubRelease,
    releaseAttempt,
    staged,
    proposal,
    proposalAttempt,
    historicalReleasePulls,
  });
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
    if (state.releaseAttempt.phase === 'absent') {
      return { type: 'authorize-github-release', durable: true, ref: RELEASE_ATTEMPT_REF, expected: null, next: state.graph.merge.sha };
    }
    if (state.releaseAttempt.phase === 'rejected') {
      return { type: 'reauthorize-github-release', durable: true, ref: RELEASE_ATTEMPT_REF, expected: state.graph.intent.sha, next: state.graph.merge.sha };
    }
    if (state.releaseAttempt.phase === 'authorized') {
      return {
        type: 'post-github-release',
        durable: true,
        attemptRef: RELEASE_ATTEMPT_REF,
        expectedAttempt: state.graph.merge.sha,
        spentAttempt: state.graph.snapshot.sha,
        rejectedAttempt: state.graph.intent.sha,
        tagName: TAG_NAME,
        targetSha: state.graph.snapshot.sha,
        body: githubReleaseBody(state),
        expectedRefs: {
          [RELEASE_REF]: state.line.headSha,
          [STAGED_REF]: state.staged.sha,
          [SNAPSHOT_REF]: state.graph.snapshot.sha,
          [TAG_REF]: state.graph.snapshot.sha,
          [RECOVERY_REF]: state.recovery.kind === 'recorded' ? state.recovery.sha : null,
          [RELEASE_ATTEMPT_REF]: state.graph.snapshot.sha,
          [PROPOSAL_ATTEMPT_REF]: null,
        },
      };
    }
    return { type: 'await-github-release-visibility', durable: false, attemptRef: RELEASE_ATTEMPT_REF };
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
  if (state.proposal.kind === 'open') {
    return { type: 'maintain-next-proposal', durable: false, pullNumber: state.proposal.pull.number };
  }
  if (state.proposalAttempt.phase === 'absent') {
    return { type: 'authorize-next-proposal', durable: true, ref: PROPOSAL_ATTEMPT_REF, expected: null, next: state.line.headSha };
  }
  if (state.proposalAttempt.phase === 'rejected') {
    return { type: 'reauthorize-next-proposal-after-rejection', durable: true, ref: PROPOSAL_ATTEMPT_REF, expected: state.graph.snapshot.sha, next: state.line.headSha };
  }
  if (state.proposalAttempt.phase === 'spent') {
    if (state.proposal.history.some((pull) => pull.state === 'closed-unmerged')) {
      return { type: 'reauthorize-next-proposal-after-close', durable: true, ref: PROPOSAL_ATTEMPT_REF, expected: state.staged.sha, next: state.line.headSha };
    }
    return { type: 'await-next-proposal-visibility', durable: false, attemptRef: PROPOSAL_ATTEMPT_REF };
  }
  return {
    type: 'post-next-proposal',
    durable: true,
    attemptRef: PROPOSAL_ATTEMPT_REF,
    expectedAttempt: state.line.headSha,
    spentAttempt: state.staged.sha,
    rejectedAttempt: state.graph.snapshot.sha,
    title: nextProposalTitle(),
    body: nextProposalBody(state),
    expectedHeadSha: state.staged.sha,
    expectedBaseSha: state.line.headSha,
    expectedRefs: {
      [RELEASE_REF]: state.line.headSha,
      [STAGED_REF]: state.staged.sha,
      [SNAPSHOT_REF]: state.graph.snapshot.sha,
      [TAG_REF]: state.graph.snapshot.sha,
      [RECOVERY_REF]: state.recovery.kind === 'recorded' ? state.recovery.sha : null,
      [RELEASE_ATTEMPT_REF]: state.graph.snapshot.sha,
      [PROPOSAL_ATTEMPT_REF]: state.staged.sha,
    },
  };
}

export async function observeMaintainerPostMerge({
  gitAdapter,
  releaseHeadSha: expectedReleaseHeadSha,
  mergeSha: expectedMergeSha,
  snapshotSha: expectedSnapshotSha,
} = {}) {
  const refsBefore = await gitAdapter.listRefs();
  const releaseHeadSha = refSha(refsBefore, RELEASE_REF);
  const snapshotSha = refSha(refsBefore, SNAPSHOT_REF);
  assertSha(releaseHeadSha, 'current advertised releases/v1.0');
  assertSha(snapshotSha, 'current advertised release-snapshots/v1.0.1');
  const authority = validateAcceptedAuthority(await gitAdapter.acceptedSnapshot(snapshotSha), snapshotSha);
  const mergeSha = authority.merge.sha;
  for (const [expected, observed, label] of [
    [expectedReleaseHeadSha, releaseHeadSha, 'release head expectation'],
    [expectedMergeSha, mergeSha, 'M expectation'],
    [expectedSnapshotSha, snapshotSha, 'V expectation'],
  ]) {
    if (expected !== undefined && expected !== null) {
      assertSha(expected, label);
      if (expected !== observed) fail(`${label} does not match current durable Git authority`);
    }
  }
  if (new Set([releaseHeadSha, mergeSha, snapshotSha]).size !== 3) fail('post-M observer roles must be distinct');
  const head = await gitAdapter.commit(releaseHeadSha);
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
    const marker = { ...common, kind: 'late-head', verifiedMergeSha: merge.sha };
    const refsAfter = await gitAdapter.listRefs();
    assertSameRefs(refsBefore, refsAfter, 'maintainer post-M refs');
    return marker;
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
    const marker = {
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
    const refsAfter = await gitAdapter.listRefs();
    assertSameRefs(refsBefore, refsAfter, 'maintainer post-M refs');
    return marker;
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

function tupleChanges(before, after, key) {
  const left = new Map(before.map((item) => [item[key], item]));
  const right = new Map(after.map((item) => [item[key], item]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort((a, b) => String(a).localeCompare(String(b)))
    .flatMap((identity) => JSON.stringify(left.get(identity) ?? null) === JSON.stringify(right.get(identity) ?? null)
      ? []
      : [{ identity, before: left.get(identity) ?? null, after: right.get(identity) ?? null }]);
}

function operationCursor(adapters) {
  return Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => [name, adapter.operations?.length ?? 0]));
}

function operationsSince(adapters, cursor) {
  return Object.entries(adapters).flatMap(([name, adapter]) =>
    (adapter.operations ?? []).slice(cursor[name] ?? 0).map((operation) => ({ adapter: name, ...operation })));
}

function assessOperations(operations) {
  const mutations = operations.filter((operation) => operation.mutation === true);
  const gitWrites = mutations.filter((operation) => operation.transport === 'git');
  const githubWrites = mutations.filter((operation) => operation.transport === 'github');
  const npmWrites = mutations.filter((operation) => operation.transport === 'npm');
  return {
    allGitWritesAllowlisted: gitWrites.every((operation) => ALLOWED_GIT_WRITE_REFS.has(operation.ref)),
    allGitHubWritesAllowlisted: githubWrites.every((operation) =>
      operation.repository === REPOSITORY &&
      operation.method === 'POST' &&
      ['/releases', '/pulls'].includes(operation.endpoint)),
    npmTransportReadOnly: npmWrites.length === 0,
    observedMutationCount: mutations.length,
    externalEpistemicBoundary:
      'Instrumentation covers this finalizer process and its exact fablebookjs/lab-01 Git/GitHub plus two npm package adapters. It does not observe unrelated external Storybook state.',
  };
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
    releaseAttempt: state.releaseAttempt,
    next: {
      staged: state.staged,
      proposal: state.proposal,
      attempt: state.proposalAttempt,
      retainedReleaseHistory: state.historicalReleasePulls ?? [],
    },
  };
}

function actionSatisfied(action, after, createdSha) {
  switch (action.type) {
    case 'fast-forward-line': return after.line.kind === 'version' && after.line.headSha === action.next;
    case 'create-reconciliation': return after.line.kind === 'normal-j' && after.line.headSha === createdSha;
    case 'create-tag': return after.tag.status === 'present' && after.tag.targetSha === action.next;
    case 'advance-staged-intent': return after.staged.kind === 'next-intent' && after.staged.sha === createdSha;
    case 'authorize-github-release':
    case 'reauthorize-github-release': return after.releaseAttempt.phase === 'authorized';
    case 'authorize-next-proposal':
    case 'reauthorize-next-proposal-after-rejection':
    case 'reauthorize-next-proposal-after-close': return after.proposalAttempt.phase === 'authorized';
    case 'post-github-release': return after.releaseAttempt.phase === 'spent';
    case 'post-next-proposal': return after.proposalAttempt.phase === 'spent';
    default: return true;
  }
}

export async function runFinalizerInvocation({ adapters, context, fault = 'none' }) {
  if (!FAULTS.includes(fault)) fail(`fault must be one of ${FAULTS.join(', ')}`);
  const cursor = operationCursor(adapters);
  const before = await observeDurableState({ ...adapters, context });
  const action = classifyNextAction(before);
  let after = before;
  let result = action.durable ? 'attempted' : 'no-op';
  let createdSha = null;
  let writeError = null;
  let postIssued = false;
  let definiteRejectionRecorded = false;
  let prePostDrift = false;
  let prePostFailure = false;
  let ambiguousSpend = false;
  let postBinding = null;
  let createdObject = null;
  const mainBindings = [];
  const durableTransitions = [];
  let durableEvidence = null;

  const partialEvidence = ({ current = null, currentError = null } = {}) => ({
    schemaVersion: 2,
    operation: 'finalize-release',
    repository: REPOSITORY,
    outcome: 'durable-write-observed-before-failure',
    context: before.context,
    before: summarizeState(before),
    action: { ...action, createdSha, postIssued },
    durableTransitions: structuredClone(durableTransitions),
    mainBindings: structuredClone(mainBindings),
    postBinding: postBinding === null ? null : structuredClone(postBinding),
    current,
    currentError,
    operations: operationsSince(adapters, cursor),
    epistemicBoundary: 'This evidence covers only exact transitions and reads observed by this finalizer process.',
  });

  const observeTransition = async ({ boundary, ref, expected, next, pushAccepted, response }) => {
    const transition = { boundary, ref, expected, next, pushAccepted, response, observedSha: null, exact: false };
    durableTransitions.push(transition);
    durableEvidence = partialEvidence();
    const observedSha = await adapters.gitAdapter.readStableRef(ref);
    transition.observedSha = observedSha;
    transition.exact = observedSha === next;
    durableEvidence = partialEvidence();
    if (!transition.exact) fail(`durable transition ${boundary} did not read back exact ${next}`);
    return observedSha;
  };

  const captureLostTransition = async ({ boundary, ref, expected, next }) => {
    const observedSha = await adapters.gitAdapter.readStableRef(ref);
    if (observedSha !== next) return observedSha;
    await observeTransition({ boundary, ref, expected, next, pushAccepted: false, response: 'lost-response-exact-readback' });
    return observedSha;
  };

  const bindTrustedMain = async (boundary) => {
    const binding = await adapters.gitAdapter.assertTrustedMain(context);
    mainBindings.push({ boundary, ...binding });
    return binding;
  };
  const guardedPush = async (ref, expected, next, boundary) => {
    await bindTrustedMain(boundary);
    await adapters.gitAdapter.pushRef(ref, expected, next, { context });
    await observeTransition({ boundary, ref, expected, next, pushAccepted: true, response: 'push-porcelain-success' });
  };
  const bindPlannedPostRefs = async () => {
    const refs = await adapters.gitAdapter.listRefs();
    const binding = await adapters.gitAdapter.assertTrustedMain(context, refs);
    mainBindings.push({ boundary: `before-github-post:${action.type}`, ...binding });
    const observed = Object.entries(action.expectedRefs).sort(([a], [b]) => a.localeCompare(b)).map(([ref, expected]) => ({
      ref,
      expected,
      observed: refSha(refs, ref),
    }));
    postBinding = { refs: observed, main: binding };
    const mismatch = observed.find(({ expected, observed: actual }) => expected !== actual);
    if (mismatch) {
      throw new PrePostDriftError(`pre-POST ref drift at ${mismatch.ref}`);
    }
    return postBinding;
  };
  const attachDurableEvidence = async (error) => {
    if (error.evidence || durableEvidence === null) return error;
    let current = null;
    let currentError = null;
    try {
      const state = await observeDurableState({ ...adapters, context });
      current = { summary: summarizeState(state), authoritativeObservation: state.authoritativeObservation };
    } catch (observationError) {
      currentError = { message: String(observationError.message).slice(0, 800) };
    }
    error.evidence = partialEvidence({ current, currentError });
    return error;
  };

  const simpleRefActions = new Set([
    'fast-forward-line',
    'create-tag',
    'authorize-github-release',
    'reauthorize-github-release',
    'authorize-next-proposal',
    'reauthorize-next-proposal-after-rejection',
    'reauthorize-next-proposal-after-close',
  ]);

  try {
    if (simpleRefActions.has(action.type)) {
      try {
        await guardedPush(action.ref, action.expected, action.next, `before-push:${action.type}`);
      } catch (error) {
        writeError = error;
        if (durableEvidence === null) {
          try { await captureLostTransition({ boundary: `after-push-error:${action.type}`, ref: action.ref, expected: action.expected, next: action.next }); } catch {}
        }
      }
    } else if (action.type === 'create-reconciliation' || action.type === 'advance-staged-intent') {
      createdSha = await adapters.gitAdapter.createCommit({ tree: action.tree, parents: action.parents, message: action.message, identity: FINALIZER_IDENTITY });
      assertSha(createdSha, 'deterministic commit');
      try {
        await guardedPush(action.ref, action.expected, createdSha, `before-push:${action.type}`);
      } catch (error) {
        writeError = error;
        if (durableEvidence === null) {
          try { await captureLostTransition({ boundary: `after-push-error:${action.type}`, ref: action.ref, expected: action.expected, next: createdSha }); } catch {}
        }
      }
    } else if (action.type === 'post-github-release' || action.type === 'post-next-proposal') {
      let transitionError = null;
      try {
        await guardedPush(
          action.attemptRef,
          action.expectedAttempt,
          action.spentAttempt,
          `before-attempt-consume:${action.type}`,
        );
      } catch (error) {
        transitionError = error;
      }
      const markerAfterTransition = await adapters.gitAdapter.readStableRef(action.attemptRef);
      if (markerAfterTransition !== action.spentAttempt) {
        writeError = transitionError ?? new Error(`${action.type} attempt authorization did not become exact spent state`);
      } else if (transitionError !== null) {
        if (durableEvidence === null) {
          await observeTransition({
            boundary: `after-attempt-consume-error:${action.type}`,
            ref: action.attemptRef,
            expected: action.expectedAttempt,
            next: action.spentAttempt,
            pushAccepted: false,
            response: 'lost-response-exact-readback',
          });
        }
        ambiguousSpend = true;
        writeError = transitionError;
      } else {
        try {
          await bindPlannedPostRefs();
        } catch (error) {
          prePostDrift = error instanceof PrePostDriftError;
          prePostFailure = !prePostDrift;
          writeError = error;
        }
        if (!prePostDrift && !prePostFailure) {
          try {
            postIssued = true;
            if (action.type === 'post-github-release') {
              createdObject = await adapters.githubAdapter.createRelease({
                tagName: action.tagName,
                targetSha: action.targetSha,
                body: action.body,
                expectedLineSha: action.expectedRefs[RELEASE_REF],
                expectedTagSha: action.expectedRefs[TAG_REF],
              });
              validateCanonicalRelease(createdObject);
              if (
                createdObject.tag_name !== action.tagName ||
                createdObject.target_commitish !== action.targetSha ||
                createdObject.name !== action.tagName ||
                createdObject.body !== action.body ||
                createdObject.draft !== false ||
                createdObject.prerelease !== false
              ) fail('created GitHub Release hydration does not bind exact V semantics');
            } else {
              createdObject = await adapters.githubAdapter.createPullRequest({
                title: action.title,
                body: action.body,
                head: STAGED_LINE,
                base: RELEASE_LINE,
                draft: true,
                expectedHeadSha: action.expectedHeadSha,
                expectedBaseSha: action.expectedBaseSha,
              });
              validateCanonicalPull(createdObject);
              if (
                createdObject.head.sha !== action.expectedHeadSha ||
                createdObject.base.sha !== action.expectedBaseSha ||
                !sameRepositorySide(createdObject.head, STAGED_LINE) ||
                !sameRepositorySide(createdObject.base, RELEASE_LINE) ||
                createdObject.title !== action.title ||
                createdObject.body !== action.body ||
                createdObject.draft !== true ||
                pullState(createdObject) !== 'open'
              ) fail('created proposal hydration does not bind exact planned head/base SHAs');
            }
          } catch (error) {
            if (error instanceof DefiniteGitHubClientError) {
              const rejectedObservation = await observeDurableState({ ...adapters, context });
              const objectAbsent = action.type === 'post-github-release'
                ? rejectedObservation.githubRelease.status === 'absent'
                : rejectedObservation.proposal.kind === 'none';
              if (!objectAbsent) {
                writeError = null;
              } else {
                await guardedPush(
                  action.attemptRef,
                  action.spentAttempt,
                  action.rejectedAttempt,
                  `record-definite-rejection:${action.type}`,
                );
                definiteRejectionRecorded = true;
              }
            } else {
              writeError = error;
            }
          }
        }
      }
    }

    if (action.durable) {
      after = await observeDurableState({ ...adapters, context });
      const satisfied = actionSatisfied(action, after, createdSha);
      const exactObjectVisible = action.type === 'post-github-release'
        ? after.githubRelease.status === 'present'
        : action.type === 'post-next-proposal'
          ? after.proposal.kind === 'open'
          : false;
      if (definiteRejectionRecorded) {
        result = 'definite-client-rejection-recorded';
      } else if (prePostFailure) {
        throw writeError;
      } else if (prePostDrift && satisfied) {
        result = 'pre-post-ref-drift-query-only';
      } else if (ambiguousSpend && satisfied) {
        result = 'attempt-spend-ambiguous-query-only';
      } else if (satisfied && exactObjectVisible) {
        result = writeError ? 'converged-after-ambiguous-response' : 'performed-and-verified';
      } else if (satisfied && postIssued) {
        result = 'post-issued-awaiting-stable-visibility';
      } else if (satisfied && writeError && !(writeError instanceof StaleLeaseError)) {
        result = 'converged-after-ambiguous-response';
      } else if (writeError instanceof StaleLeaseError) {
        result = 'stale-ref-rejected-and-refetched';
      } else if (writeError !== null) {
        throw writeError;
      } else if (satisfied) {
        result = 'performed-and-verified';
      } else {
        throw new Error(`durable action ${action.type} did not pass exact post-read`);
      }
    }

    const operations = operationsSince(adapters, cursor);
    const assessment = assessOperations(operations);
    if (!assessment.allGitWritesAllowlisted || !assessment.allGitHubWritesAllowlisted || !assessment.npmTransportReadOnly) {
      fail('instrumented finalizer operation escaped its exact write/read boundary');
    }

    const evidence = {
      schemaVersion: 2,
      operation: 'finalize-release',
      repository: REPOSITORY,
      context: before.context,
      before: summarizeState(before),
      action: { ...action, result, createdSha, postIssued, createdObject },
      after: summarizeState(after),
      preservation: {
        beforeFingerprint: before.preservationFingerprint,
        afterFingerprint: after.preservationFingerprint,
        before: before.authoritativeObservation,
        after: after.authoritativeObservation,
        changedRefs: changedRefs(before, after),
        changedPulls: tupleChanges(before.authoritativeObservation.pulls, after.authoritativeObservation.pulls, 'number'),
        changedReleases: tupleChanges(before.authoritativeObservation.releases, after.authoritativeObservation.releases, 'id'),
        changedPackages: tupleChanges(before.authoritativeObservation.packages, after.authoritativeObservation.packages, 'name'),
        mainBindings,
        postBinding,
        durableTransitions,
        operations,
        assessment,
      },
    };

    if (action.type === 'post-github-release' && fault === 'after-github-release-post' && after.githubRelease.status === 'present') {
      const error = new Error('INJECTED FAULT: GitHub Release is durable; stop before success report');
      error.evidence = evidence;
      throw error;
    }
    return evidence;
  } catch (error) {
    throw await attachDurableEvidence(error);
  }
}

function closedGitEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  };
}

function hostileEnvironmentKeys(patterns) {
  return Object.keys(process.env).filter((key) => patterns.some((pattern) => pattern.test(key)));
}

function assertClosedHttpEnvironment() {
  const hostile = hostileEnvironmentKeys(HOSTILE_HTTP_ENVIRONMENT);
  if (hostile.length > 0) fail(`hostile inherited HTTP environment: ${hostile.sort().join(', ')}`);
}

function runGit(args, { cwd = process.cwd(), input, env = {}, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    env: closedGitEnvironment(env),
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git operation failed (${result.status})`);
  }
  return result;
}

function parseLocalGitConfiguration(output) {
  return output.split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\n');
    if (separator < 1) fail('local Git configuration has a malformed entry');
    return { key: entry.slice(0, separator).toLowerCase(), value: entry.slice(separator + 1) };
  });
}

function allowedLocalGitConfiguration({ key, value }) {
  if (key === 'core.repositoryformatversion') return ['0', '1'].includes(value);
  if (key === 'core.filemode' || key === 'core.ignorecase' || key === 'core.precomposeunicode') return ['true', 'false'].includes(value);
  if (key === 'core.bare') return value === 'false';
  if (key === 'core.logallrefupdates') return value === 'true';
  if (key === 'gc.auto') return value === '0';
  if (key === 'remote.origin.url') return LIVE_REMOTE_URLS.has(value);
  if (key === 'remote.origin.fetch') return value === '+refs/heads/*:refs/remotes/origin/*';
  if (key === 'remote.origin.promisor') return value === 'true';
  if (key === 'remote.origin.partialclonefilter') return value === 'blob:none';
  if (/^branch\..+\.remote$/.test(key)) return value === 'origin';
  if (/^branch\..+\.merge$/.test(key)) return /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value);
  if (key === 'http.https://github.com/.extraheader') return /^AUTHORIZATION: basic [A-Za-z0-9+/=]+$/.test(value);
  return false;
}

export class LiveGitAdapter {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
    this.operations = [];
  }

  assertClosedTransport() {
    const hostile = hostileEnvironmentKeys(HOSTILE_GIT_ENVIRONMENT);
    if (hostile.length > 0) fail(`hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    const localResult = runGit(['config', '--local', '--null', '--list', '--includes'], { cwd: this.cwd, allowFailure: true });
    if (localResult.status !== 0) fail('could not enumerate complete local Git configuration');
    const local = parseLocalGitConfiguration(localResult.stdout);
    if (local.some((entry) => !allowedLocalGitConfiguration(entry))) {
      fail('local Git configuration contains a non-allowlisted setting');
    }

    const rewrites = runGit(['config', '--show-origin', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], {
      cwd: this.cwd,
      allowFailure: true,
    });
    if (rewrites.status !== 1 || rewrites.stdout.trim()) fail('Git URL rewriting is forbidden');

    const fetchUrls = runGit(['remote', 'get-url', '--all', 'origin'], { cwd: this.cwd }).stdout.trim().split('\n').filter(Boolean);
    const pushUrls = runGit(['remote', 'get-url', '--push', '--all', 'origin'], { cwd: this.cwd }).stdout.trim().split('\n').filter(Boolean);
    if (
      fetchUrls.length !== 1 || pushUrls.length !== 1 ||
      !LIVE_REMOTE_URLS.has(fetchUrls[0]) || !LIVE_REMOTE_URLS.has(pushUrls[0])
    ) fail('origin fetch/push destination is not the exact HTTPS lab repository');

    const headers = local.filter(({ key }) => key.endsWith('.extraheader'));
    if (headers.length > 1) fail('checkout authentication is not one exact scoped GitHub extraheader');
    return { fetchUrl: fetchUrls[0], pushUrl: pushUrls[0], scopedCheckoutAuth: headers.length === 1 };
  }

  async preflight() {
    return this.assertClosedTransport();
  }

  parseAdvertisement(output) {
    const refs = {};
    for (const row of output.trim().split('\n').filter(Boolean)) {
      const [sha, name, extra] = row.split(/\s+/);
      if (extra !== undefined || !SHA.test(sha ?? '') || !/^refs\/(?:heads|tags)\//.test(name ?? '')) {
        fail('remote advertisement contained a malformed ref tuple');
      }
      if (refs[name]) fail(`remote ref ${name} is ambiguous`);
      refs[name] = { sha, type: null };
    }
    return refs;
  }

  advertiseRefs() {
    this.assertClosedTransport();
    this.operations.push({ transport: 'git', method: 'ls-remote', mutation: false, repository: REPOSITORY });
    const result = runGit(['ls-remote', '--refs', 'origin'], { cwd: this.cwd, allowFailure: true });
    if (result.status !== 0) fail('closed Git ref advertisement failed');
    return this.parseAdvertisement(result.stdout);
  }

  async listRefs() {
    const first = this.advertiseRefs();
    this.operations.push({ transport: 'git', method: 'fetch', mutation: false, repository: REPOSITORY });
    const fetched = runGit([
      'fetch', '--force', '--prune', '--no-tags', '--no-write-fetch-head', 'origin',
      '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*',
    ], { cwd: this.cwd, allowFailure: true });
    if (fetched.status !== 0) fail('closed Git object fetch failed');
    const second = this.advertiseRefs();
    if (JSON.stringify(summarizeRefs(first)) !== JSON.stringify(summarizeRefs(second))) {
      fail('remote Git advertisement changed across the stable ref sweep');
    }
    for (const [name, value] of Object.entries(second)) {
      const typeResult = runGit(['cat-file', '-t', value.sha], { cwd: this.cwd, allowFailure: true });
      if (typeResult.status !== 0) fail(`advertised object for ${name} is unavailable after exact fetch`);
      value.type = typeResult.stdout.trim();
      if (name.startsWith('refs/heads/') && value.type !== 'commit') fail(`advertised branch ${name} is not a commit`);
      if (name.startsWith('refs/tags/') && !['commit', 'tag'].includes(value.type)) fail(`advertised tag ${name} has an invalid object type`);
    }
    return second;
  }

  async readStableRef(ref) {
    if (!/^refs\/(?:heads|tags)\//.test(ref)) fail(`stable ref read rejects ${ref}`);
    const first = this.advertiseRefs()[ref]?.sha ?? null;
    const second = this.advertiseRefs()[ref]?.sha ?? null;
    if (first !== second) fail(`remote ${ref} changed across stable read`);
    return second;
  }

  localHead() {
    const result = runGit(['rev-parse', 'HEAD'], { cwd: this.cwd, allowFailure: true });
    if (result.status !== 0 || !SHA.test(result.stdout.trim())) fail('local trusted HEAD is unavailable');
    return result.stdout.trim();
  }

  async assertTrustedMain(context, knownRefs = null) {
    this.assertClosedTransport();
    const localSha = this.localHead();
    const remoteMainSha = knownRefs
      ? refSha(knownRefs, `refs/heads/${DEFAULT_BRANCH}`)
      : await this.readStableRef(`refs/heads/${DEFAULT_BRANCH}`);
    if (
      remoteMainSha !== context.sourceSha ||
      localSha !== context.localSha ||
      localSha !== context.sourceSha ||
      context.workflowSha !== context.sourceSha
    ) fail('trusted current-main binding drifted before mutation');
    return { remoteMainSha, localSha, sourceSha: context.sourceSha, workflowSha: context.workflowSha };
  }

  commit(sha) {
    assertSha(sha, 'commit');
    const row = runGit(['rev-list', '--parents', '-n', '1', sha], { cwd: this.cwd }).stdout.trim().split(' ');
    return {
      sha,
      parents: row.slice(1),
      tree: runGit(['rev-parse', `${sha}^{tree}`], { cwd: this.cwd }).stdout.trim(),
      message: runGit(['show', '-s', '--format=%B', sha], { cwd: this.cwd }).stdout.trimEnd() + '\n',
    };
  }

  async pullCommit(number, expectedSha) {
    if (!Number.isInteger(number) || number < 1) fail('pull commit lookup requires a positive number');
    assertSha(expectedSha, 'pull head');
    this.assertClosedTransport();
    const ref = `refs/pull/${number}/head`;
    const read = () => {
      this.operations.push({ transport: 'git', method: 'ls-remote', mutation: false, repository: REPOSITORY, ref });
      const result = runGit(['ls-remote', '--refs', 'origin', ref], { cwd: this.cwd, allowFailure: true });
      const rows = result.stdout.trim().split('\n').filter(Boolean);
      if (result.status !== 0 || rows.length !== 1) fail(`pull request #${number} head ref is not exactly advertised`);
      const match = /^([0-9a-f]{40})\t(refs\/pull\/[1-9]\d*\/head)$/.exec(rows[0]);
      if (!match || match[2] !== ref) fail(`pull request #${number} head advertisement is malformed`);
      return match[1];
    };
    const first = read();
    const second = read();
    if (first !== second || second !== expectedSha) fail(`pull request #${number} head changed or mismatched its hydrated SHA`);
    this.operations.push({ transport: 'git', method: 'fetch', mutation: false, repository: REPOSITORY, ref });
    const fetched = runGit(['fetch', '--force', '--no-tags', '--no-write-fetch-head', 'origin', ref], {
      cwd: this.cwd,
      allowFailure: true,
    });
    if (fetched.status !== 0) fail(`pull request #${number} head object fetch failed`);
    return this.commit(expectedSha);
  }

  async acceptedSnapshot(snapshotSha) {
    const { source, intent, merge, snapshot, tree, contentSha256, packages } =
      await deriveTrustedSnapshotAuthority(this.cwd, snapshotSha);
    return {
      schemaVersion: 2,
      locator: SNAPSHOT_REF,
      sourceSha: source.sha,
      stagedSha: intent.sha,
      mergeSha: merge.sha,
      source,
      intent,
      merge,
      snapshot,
      treeSha: tree,
      contentSha256,
      packages,
      qa: {
        kind: 'accepted-snapshot-content',
        treeSha: tree,
        contentSha256,
        label: `accepted-snapshot-content:${tree}:${contentSha256}`,
      },
    };
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

  async pushRef(ref, expected, next, { context } = {}) {
    this.assertClosedTransport();
    if (context) await this.assertTrustedMain(context);
    const args = buildLeasedPushArguments(ref, expected, next);
    this.operations.push({ transport: 'git', method: 'push', mutation: true, repository: REPOSITORY, ref, expected, next });
    const result = runGit(args, { cwd: this.cwd, allowFailure: true });
    const refLines = result.stdout.split('\n').filter((line) => /^[!*=+ -]\t/.test(line));
    if (result.status !== 0) {
      const exact = `!\t${next}:${ref}\t[rejected] (stale info)`;
      if (refLines.length === 1 && refLines[0] === exact) throw new StaleLeaseError(ref);
      throw new Error(`guarded ref write for ${ref} failed without exact stale-lease proof`);
    }
    if (refLines.length !== 1 || !refLines[0].includes(`\t${next}:${ref}\t`)) {
      fail(`guarded ref write for ${ref} returned malformed porcelain status`);
    }
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
  constructor() {
    this.operations = [];
  }

  assertRequest(method, path) {
    assertClosedHttpEnvironment();
    const reads = [
      new RegExp(`^/repos/${REPOSITORY}$`),
      new RegExp(`^/repos/${REPOSITORY}/pulls\\?state=all&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=[1-9]\\d*$`),
      new RegExp(`^/repos/${REPOSITORY}/pulls/[1-9]\\d*$`),
      new RegExp(`^/repos/${REPOSITORY}/releases\\?per_page=${PAGE_SIZE}&page=[1-9]\\d*$`),
      new RegExp(`^/repos/${REPOSITORY}/releases/[1-9]\\d*$`),
    ];
    const writes = new Set([
      `/repos/${REPOSITORY}/releases`,
      `/repos/${REPOSITORY}/pulls`,
    ]);
    if ((method === 'GET' && reads.some((pattern) => pattern.test(path))) || (method === 'POST' && writes.has(path))) return;
    fail(`GitHub adapter rejects ${method} ${path}`);
  }

  async request(method, path, body, expectations = null) {
    this.assertRequest(method, path);
    this.operations.push({
      transport: 'github',
      method,
      mutation: method !== 'GET',
      repository: REPOSITORY,
      endpoint: path.replace(`/repos/${REPOSITORY}`, '').split('?')[0] || '/',
      expectations,
    });
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { ...githubHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let value = null;
    if (text) {
      try { value = JSON.parse(text); } catch { fail(`GitHub ${method} returned non-JSON status ${response.status}`); }
    }
    if (!response.ok) {
      if (method === 'POST' && response.status === 400) throw new DefiniteGitHubClientError(response.status, path);
      throw new Error(`GitHub ${method} ${path} failed ambiguously with status ${response.status}`);
    }
    return value;
  }

  async paginate(path) {
    const items = [];
    const seen = new Set();
    const seenPullIds = new Set();
    const identityField = path.includes('/pulls?') ? 'number' : path.includes('/releases?') ? 'id' : null;
    if (identityField === null) fail(`GitHub pagination rejects unknown collection ${path}`);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const value = await this.request('GET', `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(value)) fail(`GitHub pagination for ${path} did not return an array`);
      const keys = value.map((item) => item[identityField]);
      if (keys.some((key) => !Number.isInteger(key) || key < 1)) fail(`GitHub pagination for ${path} returned an item without its exact positive ${identityField}`);
      for (let index = 0; index < value.length; index += 1) {
        if (seen.has(keys[index])) fail(`GitHub pagination for ${path} returned a duplicate identity`);
        seen.add(keys[index]);
        if (identityField === 'number' && value[index].id !== undefined) {
          if (!Number.isInteger(value[index].id) || value[index].id < 1 || seenPullIds.has(value[index].id)) {
            fail(`GitHub pagination for ${path} returned an invalid or aliased pull id`);
          }
          seenPullIds.add(value[index].id);
        }
        items.push(value[index]);
      }
      if (value.length < PAGE_SIZE) return items;
    }
    fail(`GitHub pagination for ${path} exceeded ${MAX_PAGES} pages`);
  }

  async repository() {
    const first = await this.request('GET', `/repos/${REPOSITORY}`);
    const second = await this.request('GET', `/repos/${REPOSITORY}`);
    const tuple = (value) => ({ full_name: value?.full_name, default_branch: value?.default_branch });
    if (JSON.stringify(tuple(first)) !== JSON.stringify(tuple(second))) fail('repository identity changed across stable read');
    return tuple(second);
  }

  async pullSweep() {
    const summaries = await this.paginate(`/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc`);
    const hydrated = [];
    for (const summary of summaries) {
      if (!Number.isInteger(summary.number) || summary.number < 1) fail('pull summary lacks a positive number');
      if (summary.id !== undefined && (!Number.isInteger(summary.id) || summary.id < 1)) fail('pull summary has an invalid id');
      const detail = await this.request('GET', `/repos/${REPOSITORY}/pulls/${summary.number}`);
      if (detail?.number !== summary.number || (summary.id !== undefined && detail?.id !== summary.id)) {
        fail(`hydrated pull detail does not match requested summary #${summary.number}`);
      }
      hydrated.push(validateCanonicalPull(detail));
    }
    return hydrated.sort((a, b) => a.number - b.number);
  }

  async listPulls() {
    const first = await this.pullSweep();
    const second = await this.pullSweep();
    if (JSON.stringify(first.map(canonicalPullTuple)) !== JSON.stringify(second.map(canonicalPullTuple))) {
      fail('complete pull-request history changed across two authoritative sweeps');
    }
    return second;
  }

  async releaseSweep() {
    const summaries = await this.paginate(`/repos/${REPOSITORY}/releases`);
    const hydrated = [];
    for (const summary of summaries) {
      if (!Number.isInteger(summary.id) || summary.id < 1) fail('Release summary lacks a positive id');
      const detail = await this.request('GET', `/repos/${REPOSITORY}/releases/${summary.id}`);
      if (detail?.id !== summary.id) fail(`hydrated Release detail does not match requested summary ${summary.id}`);
      hydrated.push(validateCanonicalRelease(detail));
    }
    return hydrated.sort((a, b) => a.id - b.id);
  }

  async listReleases() {
    const first = await this.releaseSweep();
    const second = await this.releaseSweep();
    if (JSON.stringify(first.map(canonicalReleaseTuple)) !== JSON.stringify(second.map(canonicalReleaseTuple))) {
      fail('complete GitHub Release history changed across two authoritative sweeps');
    }
    return second;
  }

  async createRelease({ tagName, targetSha, body, expectedLineSha, expectedTagSha }) {
    for (const [value, label] of [[targetSha, 'Release target'], [expectedLineSha, 'Release line'], [expectedTagSha, 'Release tag']]) {
      assertSha(value, label);
    }
    if (targetSha !== expectedTagSha) fail('Release POST target/tag expectation is incompatible');
    const created = await this.request('POST', `/repos/${REPOSITORY}/releases`, {
      tag_name: tagName,
      target_commitish: targetSha,
      name: tagName,
      body,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }, { targetSha, expectedLineSha, expectedTagSha });
    if (!Number.isInteger(created?.id) || created.id < 1) fail('Release POST response lacks a positive id');
    const hydrated = await this.request('GET', `/repos/${REPOSITORY}/releases/${created.id}`);
    if (hydrated?.id !== created.id) fail('created Release hydration does not match its POST identity');
    return validateCanonicalRelease(hydrated);
  }

  async createPullRequest({ title, body, head, base, draft, expectedHeadSha, expectedBaseSha }) {
    if (!SHA.test(expectedHeadSha ?? '') || !SHA.test(expectedBaseSha ?? '')) fail('PR POST lacks exact expected head/base SHAs');
    const created = await this.request(
      'POST',
      `/repos/${REPOSITORY}/pulls`,
      { title, body, head, base, draft },
      { expectedHeadSha, expectedBaseSha },
    );
    if (!Number.isInteger(created?.number) || created.number < 1) fail('PR POST response lacks a positive number');
    const hydrated = await this.request('GET', `/repos/${REPOSITORY}/pulls/${created.number}`);
    if (hydrated?.number !== created.number || (created.id !== undefined && hydrated?.id !== created.id)) {
      fail('created pull hydration does not match its POST identity');
    }
    return validateCanonicalPull(hydrated);
  }
}

export class LiveNpmAdapter {
  constructor() {
    this.operations = [];
  }

  async observe(spec) {
    assertClosedHttpEnvironment();
    if (!PACKAGE_SPECS.some((allowed) => allowed.name === spec.name && allowed.directory === spec.directory)) {
      fail(`npm adapter rejects package ${spec.name}`);
    }
    const metadataUrl = new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, REGISTRY);
    if (metadataUrl.origin !== new URL(REGISTRY).origin) fail('npm metadata destination is not exact public registry');
    this.operations.push({ transport: 'npm', method: 'GET', mutation: false, package: spec.name, resource: 'metadata' });
    const response = await fetch(metadataUrl, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return { status: 'absent', name: spec.name };
    if (!response.ok) fail(`npm metadata read for ${spec.name} failed with ${response.status}`);
    const metadata = await response.json();
    if (typeof metadata.dist?.tarball !== 'string') fail(`npm metadata for ${spec.name} lacks a tarball URL`);
    const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
    const expectedUrl = new URL(`/${spec.name}/-/${archiveName}`, REGISTRY);
    const tarballUrl = new URL(metadata.dist.tarball);
    if (tarballUrl.href !== expectedUrl.href) fail(`PERMANENT STOP: npm ${spec.name} tarball URL is incompatible`);
    assertClosedHttpEnvironment();
    this.operations.push({ transport: 'npm', method: 'GET', mutation: false, package: spec.name, resource: 'tarball' });
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
    process.env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/finalize-release.yml@refs/heads/main` ||
    process.env.GITHUB_WORKFLOW_SHA !== process.env.GITHUB_SHA
  ) {
    fail('finalizer requires exact workflow_dispatch authority from current default main');
  }
  const localResult = runGit(['rev-parse', 'HEAD'], { cwd: repoRoot, allowFailure: true });
  const localSha = localResult.stdout.trim();
  if (localResult.status !== 0 || !SHA.test(localSha)) fail('local trusted main is unavailable');
  if (process.env.GITHUB_SHA !== localSha) fail('GITHUB_SHA does not equal checked-out trusted main');
  return {
    enforceTrustedMain: true,
    actor: process.env.GITHUB_ACTOR,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    event: process.env.GITHUB_EVENT_NAME,
    runId: process.env.GITHUB_RUN_ID,
    sourceSha: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    localSha,
  };
}

function failureEvidence(error, evidence) {
  return {
    schemaVersion: 2,
    operation: 'finalize-release',
    repository: REPOSITORY,
    outcome: 'failed-closed',
    error: { message: String(error.message).slice(0, 800) },
    durableEvidence: evidence ?? null,
    safety: {
      rawDiagnosticsEmitted: false,
      epistemicBoundary: 'Failure evidence covers only operations observed inside this finalizer process.',
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
    const rootResult = runGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd(), allowFailure: true });
    if (rootResult.status !== 0) fail('finalizer repository root is unavailable');
    const repoRoot = rootResult.stdout.trim();
    const statusResult = runGit(['status', '--porcelain'], { cwd: repoRoot, allowFailure: true });
    if (statusResult.status !== 0 || statusResult.stdout !== '') fail('finalizer requires a clean trusted-main checkout');
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
