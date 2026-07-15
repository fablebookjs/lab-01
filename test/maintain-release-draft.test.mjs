import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPullRequestBody,
  parseIntentMessage,
  validateIntent,
} from '../scripts/maintain-release-draft.mjs';

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

Automatic draft maintenance is live. A push to \`releases/v1.0\` refreshes this same draft PR from the exact new release-line head while preserving its number, base, head, and draft state.

Ready-state exact-version QA and close-and-regenerate support are implemented, but remain offline until their workflows are installed on the default branch and calibrated against the current PR. Publication, branch reconciliation, a \`v1.0.1\` tag, and a GitHub Release are not implemented. Do not mark this PR ready or close it for a lifecycle demonstration until that calibration is complete. Do not merge this release PR.

See [docs/release-process.md](https://github.com/fablebookjs/lab-01/blob/releases/v1.0/docs/release-process.md) for the current contract and safety boundary.`,
  );
});
