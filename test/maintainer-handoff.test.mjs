import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertStableOwnershipSnapshots,
  classifyMaintainerOwnership,
  classifyMaintainerOwnershipWithDurableObserver,
  durablePullCommitShas,
  readCompletePullHistory,
  settleMaintainerOwnership,
} from '../scripts/maintain-release-draft.mjs';
import { reconciliationMessage } from '../scripts/finalize-release.mjs';
import { buildSnapshotMessage } from '../scripts/release-publication.mjs';

const SOURCE = '1'.repeat(40);
const INTENT = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const LATE = '4'.repeat(40);
const SNAPSHOT = '5'.repeat(40);
const RECONCILIATION = '6'.repeat(40);
const NEXT_INTENT = '7'.repeat(40);
const PATCH = 'e'.repeat(40);
const MERGED_LATE = 'f'.repeat(40);
const CORE_SHASUM = '8'.repeat(40);
const ADDON_SHASUM = '9'.repeat(40);
const SNAPSHOT_TREE = 'a'.repeat(40);
const CONTENT_SHA256 = 'b'.repeat(64);
const SOURCE_TREE = 'c'.repeat(40);
const RECONCILIATION_TREE = 'd'.repeat(40);
const REPOSITORY = 'fablebookjs/lab-01';
const RELEASE_LINE = 'releases/v1.0';
const STAGED_LINE = 'staged/v1.0';

const intentMessage = (version, source) => `release: propose v${version}

Release-Intent-Version: 1
Release-Line: ${RELEASE_LINE}
Release-Version: ${version}
Release-Source: ${source}`;

const snapshotMessage = buildSnapshotMessage({
  mergeSha: MERGE,
  stagedSha: INTENT,
  sourceSha: SOURCE,
  tree: SNAPSHOT_TREE,
  contentSha256: CONTENT_SHA256,
  packages: [
    { name: '@fablebook/lab-01-core', integrity: 'sha512-AAAA', shasum: CORE_SHASUM },
    { name: '@fablebook/lab-01-addon', integrity: 'sha512-BBBB', shasum: ADDON_SHASUM },
  ],
});

const commit = ({ sha, parents = [], tree = `tree-${sha[0]}`, message = 'fixture' }) => ({
  sha,
  parents,
  commitTree: tree,
  parentTree: parents.length === 1 ? tree : '',
  message,
});

const mergedPull = () => ({
  number: 12,
  state: 'closed',
  draft: false,
  merged: true,
  merged_at: '2026-07-16T00:00:00Z',
  merge_commit_sha: MERGE,
  base: { ref: RELEASE_LINE, sha: SOURCE, repo: { full_name: REPOSITORY } },
  head: { ref: STAGED_LINE, sha: INTENT, repo: { full_name: REPOSITORY } },
});

const openPull = ({ number = 13, draft = true, sha = NEXT_INTENT } = {}) => ({
  number,
  state: 'open',
  draft,
  base: { ref: RELEASE_LINE, sha: RECONCILIATION, repo: { full_name: REPOSITORY } },
  head: { ref: STAGED_LINE, sha, repo: { full_name: REPOSITORY } },
});

const baseObservation = () => ({
  releaseHeadSha: MERGE,
  stagedSha: INTENT,
  pulls: [mergedPull()],
  historyComplete: true,
  commits: {
    [SOURCE]: commit({ sha: SOURCE, tree: SOURCE_TREE }),
    [INTENT]: commit({
      sha: INTENT,
      parents: [SOURCE],
      tree: SOURCE_TREE,
      message: intentMessage('1.0.1', SOURCE),
    }),
    [MERGE]: commit({ sha: MERGE, parents: [SOURCE, INTENT], tree: SOURCE_TREE }),
  },
  snapshot: null,
  postMerge: null,
});

const snapshot = () => ({
  ref: 'refs/heads/release-snapshots/v1.0.1',
  sha: SNAPSHOT,
  commit: commit({
    sha: SNAPSHOT,
    parents: [MERGE],
    tree: SNAPSHOT_TREE,
    message: snapshotMessage,
  }),
});

const lateObservation = () => ({
  ...baseObservation(),
  releaseHeadSha: LATE,
  postMerge: {
    observer: 'issue-19-finalizer',
    schemaVersion: 1,
    kind: 'late-head',
    line: RELEASE_LINE,
    version: '1.0.1',
    mergeSha: MERGE,
    verifiedMergeSha: MERGE,
    headSha: LATE,
    snapshotSha: null,
  },
});

const versionObservation = () => ({
  ...baseObservation(),
  releaseHeadSha: SNAPSHOT,
  snapshot: snapshot(),
});

const reconciliationObservation = () => ({
  ...baseObservation(),
  releaseHeadSha: RECONCILIATION,
  snapshot: snapshot(),
  commits: {
    ...baseObservation().commits,
    [RECONCILIATION]: commit({
      sha: RECONCILIATION,
      parents: [LATE, SNAPSHOT],
      tree: 'tree-reconciled',
    }),
  },
  postMerge: {
    observer: 'issue-19-finalizer',
    schemaVersion: 1,
    kind: 'normal-reconciliation',
    line: RELEASE_LINE,
    version: '1.0.1',
    mergeSha: MERGE,
    snapshotSha: SNAPSHOT,
    lateHeadSha: LATE,
    headSha: RECONCILIATION,
    expectedTreeSha: 'tree-reconciled',
    metadata: {
      schemaVersion: 1,
      line: RELEASE_LINE,
      version: '1.0.1',
      mergeSha: MERGE,
      snapshotSha: SNAPSHOT,
      lateHeadSha: LATE,
    },
  },
});

const trustedLateObservation = () => ({
  ...baseObservation(),
  releaseHeadSha: LATE,
  snapshot: snapshot(),
  commits: {
    ...baseObservation().commits,
    [LATE]: commit({ sha: LATE, parents: [MERGE], tree: RECONCILIATION_TREE, message: 'fix: late work' }),
  },
  postMerge: null,
});

const trustedMergedLateObservation = () => ({
  ...baseObservation(),
  releaseHeadSha: MERGED_LATE,
  snapshot: snapshot(),
  commits: {
    ...baseObservation().commits,
    [PATCH]: commit({
      sha: PATCH,
      parents: [MERGE],
      tree: RECONCILIATION_TREE,
      message: 'fix: ordinary late patch',
    }),
    [MERGED_LATE]: commit({
      sha: MERGED_LATE,
      parents: [MERGE, PATCH],
      tree: RECONCILIATION_TREE,
      message: 'Merge pull request #37',
    }),
  },
  postMerge: null,
});

const trustedReconciliationObservation = () => ({
  ...trustedLateObservation(),
  releaseHeadSha: RECONCILIATION,
  commits: {
    ...trustedLateObservation().commits,
    [RECONCILIATION]: commit({
      sha: RECONCILIATION,
      parents: [LATE, SNAPSHOT],
      tree: RECONCILIATION_TREE,
      message: reconciliationMessage({ mergeSha: MERGE, lateSha: LATE, snapshotSha: SNAPSHOT }),
    }),
  },
});

const trustedMergedReconciliationObservation = () => ({
  ...trustedMergedLateObservation(),
  releaseHeadSha: RECONCILIATION,
  commits: {
    ...trustedMergedLateObservation().commits,
    [RECONCILIATION]: commit({
      sha: RECONCILIATION,
      parents: [MERGED_LATE, SNAPSHOT],
      tree: RECONCILIATION_TREE,
      message: reconciliationMessage({
        mergeSha: MERGE,
        lateSha: MERGED_LATE,
        snapshotSha: SNAPSHOT,
      }),
    }),
  },
});

const toFinalizerCommit = (value) => ({
  sha: value.sha,
  parents: [...value.parents],
  tree: value.commitTree,
  message: `${value.message.trimEnd()}\n`,
});

function acceptedSnapshotAuthority(observation) {
  const source = toFinalizerCommit(observation.commits[SOURCE]);
  const intent = toFinalizerCommit(observation.commits[INTENT]);
  const merge = toFinalizerCommit(observation.commits[MERGE]);
  const accepted = toFinalizerCommit(observation.snapshot.commit);
  const packages = [
    { name: '@fablebook/lab-01-core', integrity: 'sha512-AAAA', shasum: CORE_SHASUM },
    { name: '@fablebook/lab-01-addon', integrity: 'sha512-BBBB', shasum: ADDON_SHASUM },
  ];
  return {
    schemaVersion: 2,
    locator: 'refs/heads/release-snapshots/v1.0.1',
    sourceSha: SOURCE,
    stagedSha: INTENT,
    mergeSha: MERGE,
    source,
    intent,
    merge,
    snapshot: accepted,
    treeSha: SNAPSHOT_TREE,
    contentSha256: CONTENT_SHA256,
    packages,
    qa: {
      kind: 'accepted-snapshot-content',
      treeSha: SNAPSHOT_TREE,
      contentSha256: CONTENT_SHA256,
      label: `accepted-snapshot-content:${SNAPSHOT_TREE}:${CONTENT_SHA256}`,
    },
  };
}

function durableGitAdapter(observation, { driftOnRead = null, mergeClean = true } = {}) {
  let reads = 0;
  const commits = new Map(
    [...Object.values(observation.commits), observation.snapshot?.commit]
      .filter(Boolean)
      .map((value) => [value.sha, toFinalizerCommit(value)]),
  );
  return {
    async listRefs() {
      reads += 1;
      const release = reads === driftOnRead ? 'e'.repeat(40) : observation.releaseHeadSha;
      return {
        'refs/heads/releases/v1.0': { sha: release, type: 'commit' },
        'refs/heads/staged/v1.0': { sha: observation.stagedSha, type: 'commit' },
        'refs/heads/release-snapshots/v1.0.1': { sha: SNAPSHOT, type: 'commit' },
      };
    },
    async acceptedSnapshot() {
      return acceptedSnapshotAuthority(observation);
    },
    async commit(sha) {
      return structuredClone(commits.get(sha));
    },
    async isAncestor() {
      return false;
    },
    async mergeTree() {
      return mergeClean ? { clean: true, tree: RECONCILIATION_TREE } : { clean: false, tree: null };
    },
  };
}

const nextObservation = () => ({
  releaseHeadSha: RECONCILIATION,
  stagedSha: NEXT_INTENT,
  pulls: [mergedPull(), openPull()],
  historyComplete: true,
  commits: {
    [NEXT_INTENT]: commit({
      sha: NEXT_INTENT,
      parents: [RECONCILIATION],
      tree: 'tree-next-source',
      message: intentMessage('1.0.2', RECONCILIATION),
    }),
  },
  snapshot: null,
  postMerge: null,
});

test('accepts concrete no-open M, snapshot V, and exact next 1.0.2 ownership', () => {
  assert.deepEqual(classifyMaintainerOwnership(baseObservation()), {
    owner: 'finalizer-owns-release',
    state: 'sealed-merge',
    mergeSha: MERGE,
  });
  assert.equal(classifyMaintainerOwnership(versionObservation()).state, 'version-snapshot');
  assert.deepEqual(classifyMaintainerOwnership(nextObservation()), {
    owner: 'next-proposal-owned',
    state: 'draft',
    pullNumber: 13,
    sourceSha: RECONCILIATION,
    intentSha: NEXT_INTENT,
    version: '1.0.2',
  });
});

test('hydrates only durable PR commit identities and ignores synthetic unmerged merge SHAs', () => {
  const synthetic = '0'.repeat(40);
  const open = openPull();
  open.merged = false;
  open.merge_commit_sha = synthetic;
  assert.deepEqual(durablePullCommitShas(open), [open.base.sha, open.head.sha]);

  const closedUnmerged = { ...open, state: 'closed', draft: false };
  assert.deepEqual(durablePullCommitShas(closedUnmerged), [open.base.sha, open.head.sha]);

  const merged = mergedPull();
  assert.deepEqual(durablePullCommitShas(merged), [merged.base.sha, merged.head.sha, MERGE]);
});

test('accepted handoff states never access a maintenance write or dispatch adapter', async () => {
  let calls = 0;
  const effects = new Proxy(
    {},
    {
      get() {
        calls += 1;
        throw new Error('handoff attempted an effect');
      },
    },
  );
  for (const observation of [
    baseObservation(),
    versionObservation(),
    nextObservation(),
  ]) {
    const result = await settleMaintainerOwnership({ observation, effects });
    assert.notEqual(result.owner, 'maintainer');
  }
  assert.equal(calls, 0);
});

test('concrete finalizer observer accepts exact H and deterministic J then reclassifies them', async () => {
  const late = trustedLateObservation();
  const lateSnapshot = await classifyMaintainerOwnershipWithDurableObserver({
    observation: late,
    gitAdapter: durableGitAdapter(late),
  });
  assert.deepEqual(lateSnapshot.decision, {
    owner: 'finalizer-owns-release',
    state: 'late-head',
    mergeSha: MERGE,
    headSha: LATE,
  });
  assert.equal(lateSnapshot.observation.postMerge.observer, 'issue-19-finalizer');
  const repeatedLateSnapshot = await classifyMaintainerOwnershipWithDurableObserver({
    observation: structuredClone(late),
    gitAdapter: durableGitAdapter(late),
  });
  assert.doesNotThrow(() => assertStableOwnershipSnapshots(lateSnapshot, repeatedLateSnapshot));

  const mergedLate = trustedMergedLateObservation();
  const mergedLateWithoutPatch = structuredClone(mergedLate);
  delete mergedLateWithoutPatch.commits[PATCH];
  const mergedLateSnapshot = await classifyMaintainerOwnershipWithDurableObserver({
    observation: mergedLateWithoutPatch,
    gitAdapter: durableGitAdapter(mergedLate),
  });
  assert.deepEqual(mergedLateSnapshot.decision, {
    owner: 'finalizer-owns-release',
    state: 'late-head',
    mergeSha: MERGE,
    headSha: MERGED_LATE,
  });
  assert.deepEqual(mergedLateSnapshot.observation.commits[PATCH], {
    ...mergedLate.commits[PATCH],
    parentTree: '',
  });

  const reconciled = trustedReconciliationObservation();
  const reconciledSnapshot = await classifyMaintainerOwnershipWithDurableObserver({
    observation: reconciled,
    gitAdapter: durableGitAdapter(reconciled),
  });
  assert.deepEqual(reconciledSnapshot.decision, {
    owner: 'finalizer-owns-release',
    state: 'normal-reconciliation',
    mergeSha: MERGE,
    headSha: RECONCILIATION,
    lateHeadSha: LATE,
  });
  assert.equal(reconciledSnapshot.observation.postMerge.kind, 'normal-reconciliation');

  const mergedReconciled = trustedMergedReconciliationObservation();
  const mergedReconciledWithoutPatch = structuredClone(mergedReconciled);
  delete mergedReconciledWithoutPatch.commits[PATCH];
  const mergedReconciledSnapshot = await classifyMaintainerOwnershipWithDurableObserver({
    observation: mergedReconciledWithoutPatch,
    gitAdapter: durableGitAdapter(mergedReconciled),
  });
  assert.deepEqual(mergedReconciledSnapshot.decision, {
    owner: 'finalizer-owns-release',
    state: 'normal-reconciliation',
    mergeSha: MERGE,
    headSha: RECONCILIATION,
    lateHeadSha: MERGED_LATE,
  });
  assert.deepEqual(mergedReconciledSnapshot.observation.commits[PATCH], {
    ...mergedReconciled.commits[PATCH],
    parentTree: '',
  });
});

test('concrete finalizer observer rejects ref drift and malformed/conflicting H/J shapes', async () => {
  const late = trustedLateObservation();
  await assert.rejects(
    classifyMaintainerOwnershipWithDurableObserver({
      observation: late,
      gitAdapter: durableGitAdapter(late, { driftOnRead: 3 }),
    }),
    /changed between the finalizer observer and maintainer reclassification/,
  );

  const reconciled = trustedReconciliationObservation();
  await assert.rejects(
    classifyMaintainerOwnershipWithDurableObserver({
      observation: reconciled,
      gitAdapter: durableGitAdapter(reconciled, { mergeClean: false }),
    }),
    /normal J fails exact parents, merge-tree, or structured reconciliation metadata/,
  );

  const malformed = trustedReconciliationObservation();
  malformed.commits[RECONCILIATION].message = 'self-attested but wrong';
  await assert.rejects(
    classifyMaintainerOwnershipWithDurableObserver({
      observation: malformed,
      gitAdapter: durableGitAdapter(malformed),
    }),
    /structured reconciliation metadata/,
  );

  const recovery = trustedReconciliationObservation();
  recovery.commits[RECONCILIATION].parents = [SNAPSHOT, LATE];
  await assert.rejects(
    classifyMaintainerOwnershipWithDurableObserver({
      observation: recovery,
      gitAdapter: durableGitAdapter(recovery),
    }),
    /accepts only one exact late H over M or deterministic normal J/,
  );
});

test('preserves the existing exact open 1.0.1 maintainer path', async () => {
  const observation = baseObservation();
  observation.pulls = [openPull({ number: 12, draft: false, sha: INTENT })];
  let calls = 0;
  const result = await settleMaintainerOwnership({
    observation,
    effects: {
      async maintain(decision) {
        calls += 1;
        return { ...decision, continued: true };
      },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { owner: 'maintainer', state: 'ready', pullNumber: 12, continued: true });
});

test('reads complete paginated all-state history and rejects ambiguous or duplicate pages', async () => {
  const first = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
  const calls = [];
  const pages = [first, [{ number: 101 }], first, [{ number: 101 }]];
  const pulls = await readCompletePullHistory({
    request: async (path) => {
      calls.push(path);
      return pages.shift();
    },
  });
  assert.equal(pulls.length, 101);
  assert.deepEqual(calls, [
    '/repos/fablebookjs/lab-01/pulls?state=all&per_page=100&page=1',
    '/repos/fablebookjs/lab-01/pulls?state=all&per_page=100&page=2',
    '/repos/fablebookjs/lab-01/pulls?state=all&per_page=100&page=1',
    '/repos/fablebookjs/lab-01/pulls?state=all&per_page=100&page=2',
  ]);

  await assert.rejects(
    readCompletePullHistory({ request: async () => first, maxPages: 1 }),
    /exceeded the explicit pagination bound/,
  );
  let page = 0;
  await assert.rejects(
    readCompletePullHistory({
      request: async () => (++page === 1 ? first : [{ number: 100 }]),
    }),
    /duplicate or malformed paginated PR history/,
  );
  const authority = {
    number: 12,
    state: 'open',
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    base: { ref: RELEASE_LINE, sha: SOURCE, repo: { full_name: REPOSITORY } },
    head: { ref: STAGED_LINE, sha: INTENT, repo: { full_name: REPOSITORY } },
  };
  const mutations = [
    (value) => (value.state = 'closed'),
    (value) => (value.draft = false),
    (value) => (value.merged = true),
    (value) => (value.merged_at = '2026-07-16T01:00:00Z'),
    (value) => (value.merge_commit_sha = MERGE),
    (value) => (value.base.ref = 'main'),
    (value) => (value.base.sha = LATE),
    (value) => (value.base.repo.full_name = 'fork/lab-01'),
    (value) => (value.head.ref = 'other'),
    (value) => (value.head.sha = LATE),
    (value) => (value.head.repo.full_name = 'fork/lab-01'),
  ];
  for (const mutate of mutations) {
    let sweep = 0;
    const changed = structuredClone(authority);
    mutate(changed);
    await assert.rejects(
      readCompletePullHistory({ request: async () => (++sweep === 1 ? [authority] : [changed]) }),
      /changed across complete bounded snapshots/,
    );
  }
});

test('fails closed on duplicate, malformed, stale, wrong-version, and non-draft proposal state', () => {
  const cases = [
    [
      'duplicate lifecycle history',
      () => {
        const value = baseObservation();
        value.pulls.push({ ...mergedPull() });
        return value;
      },
      /duplicated in history/,
    ],
    [
      'wrong base branch',
      () => {
        const value = baseObservation();
        value.pulls[0].base.ref = 'main';
        return value;
      },
      /unexpected repository or branch identity/,
    ],
    [
      'wrong head repository',
      () => {
        const value = baseObservation();
        value.pulls[0].head.repo.full_name = 'fork/lab-01';
        return value;
      },
      /unexpected repository or branch identity/,
    ],
    [
      'closed without merge',
      () => {
        const value = baseObservation();
        value.pulls[0].merged = false;
        value.pulls[0].merged_at = null;
        return value;
      },
      /closed without a merge commit/,
    ],
    [
      'stale staged ref',
      () => ({ ...baseObservation(), stagedSha: 'a'.repeat(40) }),
      /staged ref no longer identifies/,
    ],
    [
      'wrong next version',
      () => {
        const value = nextObservation();
        value.commits[NEXT_INTENT].message = intentMessage('1.0.3', RECONCILIATION);
        return value;
      },
      /unexpected version 1.0.3/,
    ],
    [
      'non-draft next proposal',
      () => {
        const value = nextObservation();
        value.pulls[1].draft = false;
        return value;
      },
      /must be draft/,
    ],
    [
      'next proposal base SHA is not current',
      () => {
        const value = nextObservation();
        value.pulls[1].base.sha = SOURCE;
        return value;
      },
      /base SHA does not equal the current release line/,
    ],
    [
      'open proposal without draft state',
      () => {
        const value = nextObservation();
        delete value.pulls[1].draft;
        return value;
      },
      /has no draft\/ready state/,
    ],
    [
      'multiple open lifecycle proposals',
      () => {
        const value = nextObservation();
        value.pulls.push(openPull({ number: 14, sha: NEXT_INTENT }));
        return value;
      },
      /at most one open release lifecycle PR/,
    ],
    [
      'next proposal is not latest',
      () => {
        const value = nextObservation();
        value.pulls.push({ ...mergedPull(), number: 14 });
        return value;
      },
      /not the unique latest lifecycle PR/,
    ],
    [
      'next proposal parent is stale',
      () => {
        const value = nextObservation();
        value.commits[NEXT_INTENT].parents = [MERGE];
        return value;
      },
      /parent does not equal its source/,
    ],
    [
      'next proposal changes the tree',
      () => {
        const value = nextObservation();
        value.commits[NEXT_INTENT].parentTree = 'tree-other';
        return value;
      },
      /changes the source tree/,
    ],
    [
      'incomplete next history',
      () => ({ ...nextObservation(), historyComplete: false }),
      /requires complete all-state PR history/,
    ],
    [
      'incomplete no-open history',
      () => ({ ...baseObservation(), historyComplete: false }),
      /history is incomplete or ambiguous/,
    ],
  ];
  for (const [name, fixture, pattern] of cases) {
    assert.throws(() => classifyMaintainerOwnership(fixture()), pattern, name);
  }
});

test('fails closed on malformed merged/snapshot and caller-authored H/J state', () => {
  const cases = [
    [
      'reversed M parents',
      () => {
        const value = baseObservation();
        value.commits[MERGE].parents = [INTENT, SOURCE];
        return value;
      },
      /ordered \[source, intent\]/,
    ],
    [
      'wrong M tree',
      () => {
        const value = baseObservation();
        value.commits[MERGE].commitTree = 'tree-wrong';
        return value;
      },
      /sealed source tree/,
    ],
    [
      'arbitrary H self-attestation',
      lateObservation,
      /requires the concrete durable finalizer observer/,
    ],
    [
      'wrong V parent',
      () => {
        const value = versionObservation();
        value.snapshot.commit.parents = [SOURCE];
        return value;
      },
      /one-parent transformed snapshot/,
    ],
    [
      'wrong V ref',
      () => {
        const value = versionObservation();
        value.snapshot.ref = 'refs/heads/release-snapshots/wrong';
        return value;
      },
      /does not identify exact V/,
    ],
    [
      'wrong V metadata',
      () => {
        const value = versionObservation();
        value.snapshot.commit.message = snapshotMessage.replace(`Release-Merge: ${MERGE}`, `Release-Merge: ${SOURCE}`);
        return value;
      },
      /snapshot metadata/,
    ],
    [
      'arbitrary J self-attestation',
      reconciliationObservation,
      /requires the concrete durable finalizer observer/,
    ],
  ];
  for (const [name, fixture, pattern] of cases) {
    assert.throws(() => classifyMaintainerOwnership(fixture()), pattern, name);
  }
});

const classifiedSnapshot = (observation) => ({
  observation,
  decision: classifyMaintainerOwnership(observation),
});

test('rejects same-number changes and reordered history across final ownership classification', () => {
  const firstObservation = nextObservation();
  const sameNumberChanged = nextObservation();
  sameNumberChanged.pulls[0].merged_at = '2026-07-16T02:00:00Z';
  assert.throws(
    () => assertStableOwnershipSnapshots(
      classifiedSnapshot(firstObservation),
      classifiedSnapshot(sameNumberChanged),
    ),
    /changed across complete all-state classifications/,
  );

  const reordered = nextObservation();
  reordered.pulls.reverse();
  assert.throws(
    () => assertStableOwnershipSnapshots(
      classifiedSnapshot(firstObservation),
      classifiedSnapshot(reordered),
    ),
    /changed across complete all-state classifications/,
  );
});

test('rejects a lifecycle PR created and closed between ownership snapshots', () => {
  const first = classifiedSnapshot(baseObservation());
  const changed = baseObservation();
  changed.pulls.push({
    ...openPull({ number: 13, sha: INTENT }),
    state: 'closed',
    draft: false,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
  });
  assert.throws(
    () => classifyMaintainerOwnership(changed),
    /closed without a merge commit/,
  );
  assert.equal(first.decision.state, 'sealed-merge');
});
