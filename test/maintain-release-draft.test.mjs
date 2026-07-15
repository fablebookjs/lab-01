import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMatchingReleasePull,
  buildPullRequestBody,
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

Ready-state exact-version QA is implemented. Once that workflow is present on the \`releases/v1.0\` base, ready and synchronize events run it against the current PR; no GitHub-current QA evidence has been captured yet. Its manual-dispatch fallback and close-and-regenerate remain offline until their workflows are installed on the default branch and GitHub authority is calibrated. Publication, branch reconciliation, a \`v1.0.1\` tag, and a GitHub Release are not implemented. Do not close this PR for a lifecycle demonstration until close-and-regenerate is installed and calibrated. Do not merge this release PR.

See [docs/release-process.md](https://github.com/fablebookjs/lab-01/blob/releases/v1.0/docs/release-process.md) for the current contract and safety boundary.`,
  );
});
