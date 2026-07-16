import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertMatchingReleasePull,
  assertTrustedMaintainerMain,
  buildPullRequestBody,
  dispatchReadyQaIfNeeded,
  parseIntentMessage,
  validateIntent,
  validateMaintainerWakeup,
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
      '/repos/fablebookjs/lab-01/actions/workflows/ready-release-qa-controller.yml/dispatches',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' }),
      },
    ],
  ]);

  await assert.rejects(
    dispatchReadyQaIfNeeded({ pull: ready, intent: source, request }),
    /ready release PR head does not equal the dispatched intent/,
  );
});

test('release push is a fixed read-only signal and trusted main owns guarded refresh and QA dispatch', async () => {
  const signal = await readFile(
    new URL('../.github/workflows/maintain-release-draft.yml', import.meta.url),
    'utf8',
  );
  assert.match(signal, /^name: Release maintenance signal$/m);
  assert.match(signal, /^  push:\n    branches:\n      - releases\/v1\.0$/m);
  assert.match(signal, /^permissions: \{\}$/m);
  assert.doesNotMatch(signal, /actions\/checkout|node scripts|contents: write|pull-requests: write|workflow_dispatch/);

  const controller = await readFile(new URL('../.github/workflows/maintain-release-draft-controller.yml', import.meta.url), 'utf8');
  assert.match(controller, /^name: Maintain release draft$/m);
  assert.match(controller, /workflow_run:\n    workflows:\n      - Release maintenance signal/);
  assert.match(controller, /^  workflow_dispatch:$/m);
  assert.match(controller, /^permissions: \{\}$/m);
  assert.match(controller, /permissions:\n      actions: write\n      contents: write\n      pull-requests: write/);
  assert.match(controller, /actions\/checkout@[0-9a-f]{40} # v6/);
  assert.match(controller, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(controller, /persist-credentials: false/);
  assert.match(controller, /EXPECTED_DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(controller, /EXPECTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(controller, /node scripts\/maintain-release-draft\.mjs/);
});

test('maintainer wake-ups are non-authoritative exact signal/manual shapes and every write rebinds main', () => {
  const actor = { id: 7, login: 'maintainer' };
  const repository = { id: 1301358254, full_name: 'fablebookjs/lab-01' };
  const event = {
    action: 'completed', repository, sender: actor,
    workflow_run: {
      id: 99, name: 'Release maintenance signal', event: 'push', status: 'completed', conclusion: 'success',
      head_branch: 'releases/v1.0', repository, head_repository: repository, actor, triggering_actor: actor,
    },
  };
  assert.deepEqual(validateMaintainerWakeup({ eventName: 'workflow_run', event }), { event: 'workflow_run', actor: 'maintainer', runId: 99 });
  assert.deepEqual(validateMaintainerWakeup({ eventName: 'workflow_dispatch', event: { repository, sender: actor, inputs: {} } }), { event: 'workflow_dispatch', actor: 'maintainer' });
  const unrelatedClose = structuredClone(event);
  unrelatedClose.workflow_run.name = 'Release regeneration signal';
  unrelatedClose.workflow_run.event = 'pull_request_target';
  unrelatedClose.workflow_run.head_branch = 'fix+valid/_branch';
  assert.deepEqual(validateMaintainerWakeup({ eventName: 'workflow_run', event: unrelatedClose }), {
    event: 'workflow_run',
    actor: 'maintainer',
    runId: 99,
    action: 'ignored-unrelated-signal',
  });
  const malformedClose = structuredClone(unrelatedClose);
  malformedClose.workflow_run.head_branch = 'bad..branch';
  assert.throws(() => validateMaintainerWakeup({ eventName: 'workflow_run', event: malformedClose }));
  malformedClose.workflow_run.head_branch = '/suspicious';
  assert.throws(() => validateMaintainerWakeup({ eventName: 'workflow_run', event: malformedClose }));
  for (const mutate of [
    (value) => { value.workflow_run.name = 'Maintain release draft'; },
    (value) => { value.workflow_run.event = 'workflow_dispatch'; },
    (value) => { value.workflow_run.head_branch = 'staged/v1.0'; },
    (value) => { value.workflow_run.conclusion = 'failure'; },
    (value) => { value.workflow_run.head_repository.full_name = 'fork/lab-01'; },
  ]) {
    const forged = structuredClone(event); mutate(forged);
    assert.throws(() => validateMaintainerWakeup({ eventName: 'workflow_run', event: forged }));
  }
  const main = 'a'.repeat(40);
  assert.equal(assertTrustedMaintainerMain({ environment: {
    GITHUB_REPOSITORY: 'fablebookjs/lab-01', GITHUB_REF: 'refs/heads/main',
    EXPECTED_DISPATCH_SHA: main, EXPECTED_WORKFLOW_SHA: main,
  }, localSha: main, remoteMainSha: main }), main);
  assert.throws(() => assertTrustedMaintainerMain({ environment: {
    GITHUB_REPOSITORY: 'fablebookjs/lab-01', GITHUB_REF: 'refs/heads/main',
    EXPECTED_DISPATCH_SHA: 'b'.repeat(40), EXPECTED_WORKFLOW_SHA: main,
  }, localSha: main, remoteMainSha: main }), /drifted/);
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

Historical automation demonstrated release-proposal refresh, Ready QA, and close-and-regenerate. Default-main trusted controllers are now installed; release and PR workflows remain fixed read-only/no-checkout signals, and controllers re-observe every durable ref and PR fact before acting. The trusted-main maintainer dispatches \`ready-release-qa-controller.yml\` only at \`main\`, while npm trusted publishing uses the exact stable workflow filename \`publish-npm.yml\`.

The manual operator-only exact \`1.0.0\` bootstrap exists but has not published. The trusted-main maintainer, Ready-QA controller, \`V\` preparation, direct-OIDC publisher, finalizer, and H/J handoff are installed but have not completed a real release. The \`npm-publish\` environment exists with no secrets or reviewers and permits only \`main\`. No current-head QA success, public package, snapshot, or finalization is claimed; baseline packages, both npm trusted-publisher settings, and a real post-installation QA run remain external gates.

This maintainer never publishes, reconciles the release line, tags, or creates a GitHub Release. It validates the open \`1.0.1\` proposal, sealed merge \`M\`, exact deterministic \`V\`, concrete \`H\`, deterministic \`J\`, and an exact draft \`1.0.2\` proposal from trusted-main code. Caller-supplied H/J facts are rejected; two complete ownership snapshots rederive and reclassify the durable graph. The issue #19 operator gate remains closed.

See [docs/release-process.md](https://github.com/fablebookjs/lab-01/blob/releases/v1.0/docs/release-process.md) for the current contract and safety boundary.`,
  );
});
