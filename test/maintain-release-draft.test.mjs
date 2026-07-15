import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertMatchingReleasePull,
  buildPullRequestBody,
  dispatchReadyQaIfNeeded,
  parseIntentMessage,
  validateIntent,
} from '../scripts/maintain-release-draft.mjs';

const releasePull = (draft) => ({
  state: 'open',
  draft,
  base: { ref: 'releases/v1.0', repo: { full_name: 'fablebookjs/lab-01' } },
  head: { ref: 'staged/v1.0', repo: { full_name: 'fablebookjs/lab-01' } },
});

const source = '1111111111111111111111111111111111111111';
const intent = '2222222222222222222222222222222222222222';
const message = `release: propose v1.0.1

Release-Intent-Version: 1
Release-Line: releases/v1.0
Release-Version: 1.0.1
Release-Source: ${source}`;

test('accepts only a one-parent empty intent with exact structured trailers', () => {
  assert.doesNotThrow(() =>
    validateIntent(
      {
        message,
        parents: [source],
        commitTree: 'tree',
        parentTree: 'tree',
      },
      { source },
    ),
  );

  assert.throws(
    () =>
      validateIntent(
        {
          message,
          parents: [source],
          commitTree: 'changed-tree',
          parentTree: 'tree',
        },
        { source },
      ),
    /changes the source tree/,
  );
  assert.throws(
    () =>
      validateIntent(
        {
          message: message.replace('Release-Version: 1.0.1', 'Release-Version: 1.0.2'),
          parents: [source],
          commitTree: 'tree',
          parentTree: 'tree',
        },
        { source },
      ),
    /Release-Version/,
  );
});

test('rejects duplicate or unexpected trailers', () => {
  assert.throws(() => parseIntentMessage(`${message}\nRelease-Source: ${source}`), /duplicate/);
  assert.throws(
    () =>
      validateIntent(
        {
          message: `${message}\nUnexpected: value`,
          parents: [source],
          commitTree: 'tree',
          parentTree: 'tree',
        },
        { source },
      ),
    /unexpected trailers/,
  );
});

test('accepts the same open release PR after it becomes ready', () => {
  assert.doesNotThrow(() => assertMatchingReleasePull(releasePull(true)));
  assert.doesNotThrow(() => assertMatchingReleasePull(releasePull(false)));
  assert.throws(
    () => assertMatchingReleasePull({ ...releasePull(true), draft: undefined }),
    /expected open lifecycle PR/,
  );
});

test('explicitly dispatches exact-head QA only for a ready release PR', async () => {
  const calls = [];
  const request = async (...args) => calls.push(args);
  const ready = { ...releasePull(false), head: { ...releasePull(false).head, sha: intent } };
  const draft = { ...releasePull(true), head: { ...releasePull(true).head, sha: intent } };

  assert.deepEqual(
    await dispatchReadyQaIfNeeded({ pull: draft, intent, request }),
    { action: 'not-dispatched-draft' },
  );
  assert.deepEqual(calls, []);

  assert.deepEqual(
    await dispatchReadyQaIfNeeded({ pull: ready, intent, request }),
    { action: 'dispatched-ready-qa', intent },
  );
  assert.deepEqual(calls, [
    [
      '/repos/fablebookjs/lab-01/actions/workflows/ready-release-qa.yml/dispatches',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'staged/v1.0' }),
      },
    ],
  ]);

  await assert.rejects(
    dispatchReadyQaIfNeeded({ pull: ready, intent: source, request }),
    /ready release PR head does not equal the dispatched intent/,
  );
});

test('release-PR maintenance has only the authority needed for guarded refresh and QA dispatch', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/maintain-release-draft.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /permissions:\n  actions: write\n  contents: write\n  pull-requests: write/,
  );
  assert.match(workflow, /node scripts\/maintain-release-draft\.mjs/);
});

test('renders the exact current intent and honest lifecycle limits', () => {
  assert.equal(
    buildPullRequestBody({
      source,
      intent,
      includedCommits: [{ sha: source, subject: 'fix(core): keep zero in sums' }],
    }),
    `## Release intent

- Release line: \`releases/v1.0\`
- Proposed version: \`1.0.1\`
- Exact release source: \`${source}\`
- Structured intent commit: \`${intent}\`

The structured empty commit is authoritative. This editable title and body are presentation only.

## Included commits since \`v1.0.0\`

- \`${source}\` fix(core): keep zero in sums

## Current lifecycle state

Automatic release-PR maintenance is live. A push to \`releases/v1.0\` refreshes this same PR from the exact new release-line head while preserving its number, base, head, and draft-or-ready review state.

Ready-state exact-version QA is live. Marking the current proposal ready runs QA for that exact head. When a ready proposal refreshes, release-PR maintenance explicitly dispatches QA for the new staged head because GitHub leaves token-authored synchronize runs approval-required. The first ready proof is [run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684), and the first automatically refreshed-head proof is [run 29414043206](https://github.com/fablebookjs/lab-01/actions/runs/29414043206). Close-and-regenerate is live: [run 29414470336](https://github.com/fablebookjs/lab-01/actions/runs/29414470336) closed historical PR #1, created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12), and converged on that same replacement when rerun. Offline snapshot and direct-OIDC publisher preparation exists, but public baseline packages, npm trusted-publisher settings, the GitHub environment, and current-head QA remain external gates.

This maintainer never publishes, reconciles the release line, tags, or creates a GitHub Release. After an exact merge, it validates the sealed M/post-M handoff and leaves all writes to the separately reviewed issue #19 finalizer. It likewise recognizes the finalizer's exact draft \`1.0.2\` proposal without refreshing it as \`1.0.1\` or dispatching \`1.0.1\` QA. That finalizer is not installed by this change; merge only when the issue #19 operator gate says it is ready.

See [docs/release-process.md](https://github.com/fablebookjs/lab-01/blob/releases/v1.0/docs/release-process.md) for the current contract and safety boundary.`,
  );
});
