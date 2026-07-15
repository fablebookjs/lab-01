import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildIntentMessage,
  validateIntent,
} from '../scripts/maintain-release-draft.mjs';
import {
  buildExpectedOldRefUpdate,
  classifyCloseEvent,
  reconcileClosedPull,
} from '../scripts/regenerate-release-draft.mjs';

const repository = 'fablebookjs/lab-01';
const sourceA = '1111111111111111111111111111111111111111';
const sourceB = '2222222222222222222222222222222222222222';
const closedIntent = '3333333333333333333333333333333333333333';
const freshIntentA = '4444444444444444444444444444444444444444';
const freshIntentB = '5555555555555555555555555555555555555555';
const concurrentIntent = '6666666666666666666666666666666666666666';

function pull({
  number,
  state = 'closed',
  draft = false,
  merged = false,
  mergedAt = null,
  headSha = closedIntent,
  baseRef = 'releases/v1.0',
  headRef = 'staged/v1.0',
  headRepository = repository,
} = {}) {
  return {
    number,
    state,
    draft,
    merged,
    merged_at: mergedAt,
    base: { ref: baseRef, repo: { full_name: repository } },
    head: {
      ref: headRef,
      sha: headSha,
      label: `fablebookjs:${headRef}`,
      repo: { full_name: headRepository },
    },
  };
}

function eventFor(pullRequest, action = 'closed') {
  return {
    action,
    repository: { full_name: repository },
    pull_request: pullRequest,
  };
}

function state({
  releaseSource = sourceA,
  stagedIntent = closedIntent,
  stagedCurrent = true,
  pulls = [pull({ number: 7 })],
} = {}) {
  return {
    releaseSource,
    stagedIntent,
    stagedCurrent,
    includedCommits: [{ sha: releaseSource, subject: 'fix(core): synthetic fix' }],
    pulls,
  };
}

function fakeAdapter({ states, refs = [], intents = [], createdPullNumber = 8 }) {
  const calls = {
    createFreshIntent: [],
    updateStagedRef: [],
    createPull: [],
  };
  let stateIndex = 0;
  let refIndex = 0;
  let intentIndex = 0;
  const next = (items, index) => items[Math.min(index, items.length - 1)];

  return {
    calls,
    adapter: {
      readState: async () => next(states, stateIndex++),
      readRemoteRefs: async () => next(refs, refIndex++),
      createFreshIntent: async (input) => {
        calls.createFreshIntent.push(input);
        return next(intents, intentIndex++);
      },
      updateStagedRef: async (update) => {
        calls.updateStagedRef.push(update);
      },
      createPull: async (request) => {
        calls.createPull.push(request);
        return pull({
          number: createdPullNumber,
          state: 'open',
          draft: true,
          headSha: request.head === 'staged/v1.0' ? states.at(-1).stagedIntent : '',
        });
      },
    },
  };
}

test('an unmerged close writes one fresh intent and creates one draft replacement', async () => {
  const closed = pull({ number: 7 });
  const harness = fakeAdapter({
    states: [
      state({ pulls: [closed] }),
      state({ stagedIntent: freshIntentA, pulls: [closed] }),
    ],
    refs: [
      { releaseSource: sourceA, stagedIntent: closedIntent },
      { releaseSource: sourceA, stagedIntent: freshIntentA },
      { releaseSource: sourceA, stagedIntent: freshIntentA },
    ],
    intents: [freshIntentA],
  });

  const result = await reconcileClosedPull({
    event: eventFor(closed),
    adapter: harness.adapter,
  });

  assert.equal(result.action, 'created-replacement');
  assert.equal(harness.calls.updateStagedRef.length, 1);
  assert.equal(harness.calls.createPull.length, 1);
  assert.deepEqual(
    {
      title: harness.calls.createPull[0].title,
      head: harness.calls.createPull[0].head,
      base: harness.calls.createPull[0].base,
      draft: harness.calls.createPull[0].draft,
    },
    {
      title: 'release: propose v1.0.1',
      head: 'staged/v1.0',
      base: 'releases/v1.0',
      draft: true,
    },
  );
  assert.match(harness.calls.createPull[0].body, new RegExp(sourceA));
  assert.match(harness.calls.createPull[0].body, new RegExp(freshIntentA));
});

test('a latest merged release pull request is a no-op after durable event validation', async () => {
  const merged = pull({
    number: 7,
    merged: true,
    mergedAt: '2026-07-15T10:00:00Z',
  });
  const harness = fakeAdapter({ states: [state({ pulls: [merged] })] });

  assert.deepEqual(
    await reconcileClosedPull({ event: eventFor(merged), adapter: harness.adapter }),
    { action: 'ignored-merged', pullRequest: 7 },
  );
  assert.deepEqual(harness.calls.updateStagedRef, []);
  assert.deepEqual(harness.calls.createPull, []);
});

test('unrelated closes are ignored while suspicious release identities fail closed', async () => {
  const unrelated = pull({ number: 9, baseRef: 'main', headRef: 'feature/example' });
  assert.deepEqual(classifyCloseEvent(eventFor(unrelated)), { action: 'ignored-unrelated' });

  const fork = pull({ number: 9, headRepository: 'attacker/fork' });
  assert.throws(() => classifyCloseEvent(eventFor(fork)), /unexpected base, head, or repository/);

  const wrongHead = pull({ number: 9, headRef: 'feature/example' });
  assert.deepEqual(classifyCloseEvent(eventFor(wrongHead)), { action: 'ignored-unrelated' });

  const wrongBase = pull({ number: 9, baseRef: 'main' });
  assert.throws(
    () => classifyCloseEvent(eventFor(wrongBase)),
    /unexpected base, head, or repository/,
  );
});

test('a delayed old close recognizes a newer current open replacement without mutation', async () => {
  const closed = pull({ number: 7 });
  const replacement = pull({
    number: 8,
    state: 'open',
    draft: true,
    headSha: freshIntentA,
  });
  const harness = fakeAdapter({
    states: [state({ stagedIntent: freshIntentA, pulls: [closed, replacement] })],
  });

  const result = await reconcileClosedPull({
    event: eventFor(closed),
    adapter: harness.adapter,
  });

  assert.equal(result.action, 'replacement-exists');
  assert.equal(result.pullRequest, 8);
  assert.deepEqual(harness.calls.updateStagedRef, []);
  assert.deepEqual(harness.calls.createPull, []);
});

test('a delayed old close replaces the latest newer closed lifecycle PR', async () => {
  const stale = pull({ number: 7 });
  const newerClosed = pull({ number: 8, headSha: concurrentIntent });
  const harness = fakeAdapter({
    states: [
      state({ stagedIntent: concurrentIntent, pulls: [stale, newerClosed] }),
      state({ stagedIntent: freshIntentA, pulls: [stale, newerClosed] }),
    ],
    refs: [
      { releaseSource: sourceA, stagedIntent: concurrentIntent },
      { releaseSource: sourceA, stagedIntent: freshIntentA },
      { releaseSource: sourceA, stagedIntent: freshIntentA },
    ],
    intents: [freshIntentA],
    createdPullNumber: 9,
  });

  const result = await reconcileClosedPull({
    event: eventFor(stale),
    adapter: harness.adapter,
  });

  assert.equal(result.action, 'created-replacement');
  assert.equal(result.closedPullRequest, 8);
  assert.equal(result.pullRequest, 9);
  assert.deepEqual(harness.calls.createFreshIntent, [
    { source: sourceA, previousIntent: concurrentIntent },
  ]);
  assert.equal(harness.calls.updateStagedRef.length, 1);
  assert.equal(harness.calls.updateStagedRef[0].expectedOld, concurrentIntent);
  assert.equal(harness.calls.updateStagedRef[0].intent, freshIntentA);
  assert.equal(harness.calls.createPull.length, 1);
});

test('a delayed old close fails closed when the newer open replacement is stale', async () => {
  const stale = pull({ number: 7 });
  const newerOpen = pull({
    number: 8,
    state: 'open',
    draft: true,
    headSha: concurrentIntent,
  });
  const harness = fakeAdapter({
    states: [
      state({
        stagedIntent: concurrentIntent,
        stagedCurrent: false,
        pulls: [stale, newerOpen],
      }),
    ],
  });

  await assert.rejects(
    reconcileClosedPull({ event: eventFor(stale), adapter: harness.adapter }),
    /open replacement release pull request is based on a stale staged intent/,
  );
  assert.deepEqual(harness.calls.updateStagedRef, []);
  assert.deepEqual(harness.calls.createPull, []);
});

test('a concurrent release advance is rederived before the expected-old write', async () => {
  const closed = pull({ number: 7 });
  const harness = fakeAdapter({
    states: [
      state({ pulls: [closed] }),
      state({
        releaseSource: sourceB,
        stagedCurrent: false,
        pulls: [closed],
      }),
      state({
        releaseSource: sourceB,
        stagedIntent: freshIntentB,
        pulls: [closed],
      }),
    ],
    refs: [
      { releaseSource: sourceB, stagedIntent: closedIntent },
      { releaseSource: sourceB, stagedIntent: closedIntent },
      { releaseSource: sourceB, stagedIntent: freshIntentB },
      { releaseSource: sourceB, stagedIntent: freshIntentB },
    ],
    intents: [freshIntentA, freshIntentB],
  });

  const result = await reconcileClosedPull({
    event: eventFor(closed),
    adapter: harness.adapter,
  });

  assert.equal(result.releaseSource, sourceB);
  assert.equal(harness.calls.updateStagedRef.length, 1);
  assert.equal(harness.calls.updateStagedRef[0].intent, freshIntentB);
  assert.equal(harness.calls.updateStagedRef[0].expectedOld, closedIntent);
});

test('a concurrent staged advance is adopted without overwriting it', async () => {
  const closed = pull({ number: 7 });
  const harness = fakeAdapter({
    states: [
      state({ pulls: [closed] }),
      state({ stagedIntent: concurrentIntent, pulls: [closed] }),
    ],
    refs: [
      { releaseSource: sourceA, stagedIntent: concurrentIntent },
      { releaseSource: sourceA, stagedIntent: concurrentIntent },
    ],
    intents: [freshIntentA],
  });

  const result = await reconcileClosedPull({
    event: eventFor(closed),
    adapter: harness.adapter,
  });

  assert.equal(result.intent, concurrentIntent);
  assert.deepEqual(harness.calls.updateStagedRef, []);
  assert.equal(harness.calls.createPull.length, 1);
});

test('the replacement intent remains an exact empty structured commit', () => {
  const message = buildIntentMessage({ source: sourceA });
  assert.equal(
    message,
    `release: propose v1.0.1

Release-Intent-Version: 1
Release-Line: releases/v1.0
Release-Version: 1.0.1
Release-Source: ${sourceA}
`,
  );
  assert.doesNotThrow(() =>
    validateIntent(
      {
        message,
        parents: [sourceA],
        commitTree: 'same-tree',
        parentTree: 'same-tree',
      },
      { source: sourceA },
    ),
  );
});

test('the staged update encodes the exact expected old SHA', () => {
  assert.deepEqual(
    buildExpectedOldRefUpdate({ expectedOld: closedIntent, intent: freshIntentA }),
    {
      ref: 'refs/heads/staged/v1.0',
      expectedOld: closedIntent,
      intent: freshIntentA,
      pushArgs: [
        'push',
        `--force-with-lease=refs/heads/staged/v1.0:${closedIntent}`,
        'origin',
        `${freshIntentA}:refs/heads/staged/v1.0`,
      ],
    },
  );
});

test('the installable workflow uses only trusted release code and bounded write authority', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/regenerate-release-draft.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /types:\n      - closed/);
  assert.match(workflow, /contents: write\n  pull-requests: write/);
  assert.match(workflow, /uses: actions\/checkout@v7/);
  assert.match(workflow, /ref: releases\/v1\.0/);
  assert.doesNotMatch(workflow, /pull_request\.head|github\.head_ref/);
});
