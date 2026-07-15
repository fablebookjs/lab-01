import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyMaintainerOwnership,
  readCompletePullHistory,
  settleMaintainerOwnership,
} from '../scripts/maintain-release-draft.mjs';

const SOURCE = '1'.repeat(40);
const INTENT = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const LATE = '4'.repeat(40);
const SNAPSHOT = '5'.repeat(40);
const RECONCILIATION = '6'.repeat(40);
const NEXT_INTENT = '7'.repeat(40);
const CORE_SHASUM = '8'.repeat(40);
const ADDON_SHASUM = '9'.repeat(40);
const REPOSITORY = 'fablebookjs/lab-01';
const RELEASE_LINE = 'releases/v1.0';
const STAGED_LINE = 'staged/v1.0';

const intentMessage = (version, source) => `release: propose v${version}

Release-Intent-Version: 1
Release-Line: ${RELEASE_LINE}
Release-Version: ${version}
Release-Source: ${source}`;

const snapshotMessage = `release: snapshot v1.0.1

Release-Snapshot-Version: 1
Release-Line: ${RELEASE_LINE}
Release-Version: 1.0.1
Release-Merge: ${MERGE}
Release-QA-Run: 123
Release-QA-Staged: ${INTENT}
Release-QA-Source: ${SOURCE}
Core-Integrity: sha512-AAAA
Core-Shasum: ${CORE_SHASUM}
Addon-Integrity: sha512-BBBB
Addon-Shasum: ${ADDON_SHASUM}`;

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
    [SOURCE]: commit({ sha: SOURCE, tree: 'tree-source' }),
    [INTENT]: commit({
      sha: INTENT,
      parents: [SOURCE],
      tree: 'tree-source',
      message: intentMessage('1.0.1', SOURCE),
    }),
    [MERGE]: commit({ sha: MERGE, parents: [SOURCE, INTENT], tree: 'tree-source' }),
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
    tree: 'tree-version-101',
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

test('accepts no-open M, late H, snapshot V, normal J, and exact next 1.0.2 ownership', () => {
  assert.deepEqual(classifyMaintainerOwnership(baseObservation()), {
    owner: 'finalizer-owns-release',
    state: 'sealed-merge',
    mergeSha: MERGE,
  });
  assert.equal(classifyMaintainerOwnership(lateObservation()).state, 'late-head');
  assert.equal(classifyMaintainerOwnership(versionObservation()).state, 'version-snapshot');
  assert.equal(classifyMaintainerOwnership(reconciliationObservation()).state, 'normal-reconciliation');
  assert.deepEqual(classifyMaintainerOwnership(nextObservation()), {
    owner: 'next-proposal-owned',
    state: 'draft',
    pullNumber: 13,
    sourceSha: RECONCILIATION,
    intentSha: NEXT_INTENT,
    version: '1.0.2',
  });
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
    lateObservation(),
    versionObservation(),
    reconciliationObservation(),
    nextObservation(),
  ]) {
    const result = await settleMaintainerOwnership({ observation, effects });
    assert.notEqual(result.owner, 'maintainer');
  }
  assert.equal(calls, 0);
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
  const pages = [first, [{ number: 101 }], first];
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
  let changed = 0;
  await assert.rejects(
    readCompletePullHistory({
      request: async () => (++changed === 1 ? [{ number: 1 }] : [{ number: 2 }]),
    }),
    /history changed while paginating/,
  );
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

test('fails closed on merged, snapshot, and post-M graph contradictions', () => {
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
      'unexplained post-M line',
      () => ({ ...baseObservation(), releaseHeadSha: LATE }),
      /lacks an exact finalizer observation binding/,
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
      'stale H binding',
      () => {
        const value = lateObservation();
        value.postMerge.mergeSha = SOURCE;
        return value;
      },
      /lacks an exact finalizer observation binding/,
    ],
    [
      'reversed J parents',
      () => {
        const value = reconciliationObservation();
        value.commits[RECONCILIATION].parents = [SNAPSHOT, LATE];
        return value;
      },
      /normal J finalizer binding or graph/,
    ],
    [
      'wrong J structured metadata',
      () => {
        const value = reconciliationObservation();
        value.postMerge.metadata.snapshotSha = SOURCE;
        return value;
      },
      /normal J finalizer binding or graph/,
    ],
    [
      'wrong J tree',
      () => {
        const value = reconciliationObservation();
        value.commits[RECONCILIATION].commitTree = 'tree-wrong';
        return value;
      },
      /normal J finalizer binding or graph/,
    ],
  ];
  for (const [name, fixture, pattern] of cases) {
    assert.throws(() => classifyMaintainerOwnership(fixture()), pattern, name);
  }
});
