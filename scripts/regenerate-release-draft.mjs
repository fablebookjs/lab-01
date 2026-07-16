import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  assertTrustedMaintainerMain,
  buildIntentMessage,
  buildPullRequestBody,
  readCompletePullHistory,
  validateIntent,
  validateMaintainerWakeup,
} from './maintain-release-draft.mjs';
import { assertSafeGitConfiguration, closedGitEnvironment } from './release-publication.mjs';

const REPOSITORY = 'fablebookjs/lab-01';
const RELEASE_LINE = 'releases/v1.0';
const STAGED_LINE = 'staged/v1.0';
const BASELINE_TAG = 'v1.0.0';
const RELEASE_VERSION = '1.0.1';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const git = (...args) =>
  execFileSync('git', args[0] === '--no-replace-objects' ? args : ['--no-replace-objects', ...args], {
    encoding: 'utf8',
    env: closedGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fail = (message) => {
  throw new Error(message);
};

class RetryableStateError extends Error {}

export class GitHubRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function classifyCloseEvent(event, repository = REPOSITORY) {
  if (repository !== REPOSITORY) fail(`refusing to write outside ${REPOSITORY}`);
  if (event?.repository?.full_name !== REPOSITORY) {
    fail('pull request event repository is not the laboratory repository');
  }

  const pull = event.pull_request;
  if (!pull) fail('pull request event is missing pull_request data');

  const baseRef = pull.base?.ref;
  const headRef = pull.head?.ref;
  if (headRef !== STAGED_LINE) {
    return { action: 'ignored-unrelated' };
  }

  if (event.action !== 'closed' || pull.state !== 'closed') {
    fail('release pull request wake-up is not a closed pull request');
  }
  if (
    baseRef !== RELEASE_LINE ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    headRef !== STAGED_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY ||
    pull.head?.label !== `fablebookjs:${STAGED_LINE}`
  ) {
    fail('release pull request wake-up has unexpected base, head, or repository identity');
  }
  if (!Number.isInteger(pull.number) || pull.number <= 0) {
    fail('release pull request wake-up has an invalid pull request number');
  }
  if (!SHA_PATTERN.test(pull.head.sha ?? '')) {
    fail('release pull request wake-up has an invalid head SHA');
  }
  return {
    action: 'regenerate',
    pullRequest: pull.number,
    closedHead: pull.head.sha,
  };
}

function assertLifecyclePull(pull) {
  if (
    !Number.isInteger(pull.number) ||
    pull.number <= 0 ||
    pull.base?.ref !== RELEASE_LINE ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    pull.head?.ref !== STAGED_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY ||
    !SHA_PATTERN.test(pull.head?.sha ?? '')
  ) {
    fail('GitHub returned a release pull request with unexpected identity');
  }
}

export function selectLifecyclePulls(pulls) {
  if (!Array.isArray(pulls)) fail('GitHub did not return a pull request list');

  const candidates = pulls.filter(
    (pull) => pull.base?.ref === RELEASE_LINE && pull.head?.ref === STAGED_LINE,
  );
  for (const pull of candidates) assertLifecyclePull(pull);

  return [...candidates].sort((left, right) => left.number - right.number);
}

export function buildExpectedOldRefUpdate({ expectedOld, intent }) {
  if (!SHA_PATTERN.test(expectedOld ?? '') || !SHA_PATTERN.test(intent ?? '')) {
    fail('guarded staged update requires exact old and new SHAs');
  }
  return {
    ref: `refs/heads/${STAGED_LINE}`,
    expectedOld,
    intent,
    pushArgs: [
      'push',
      `--force-with-lease=refs/heads/${STAGED_LINE}:${expectedOld}`,
      'origin',
      `${intent}:refs/heads/${STAGED_LINE}`,
    ],
  };
}

export function buildCreatePullRequestRequest({ body }) {
  return {
    title: `release: propose v${RELEASE_VERSION}`,
    head: STAGED_LINE,
    base: RELEASE_LINE,
    body,
    draft: true,
  };
}

function assertState(state) {
  if (
    !SHA_PATTERN.test(state?.releaseSource ?? '') ||
    !SHA_PATTERN.test(state?.stagedIntent ?? '') ||
    !Array.isArray(state?.includedCommits)
  ) {
    fail('durable release state is incomplete');
  }
}

function assertReplacementPull(pull, stagedIntent) {
  assertLifecyclePull(pull);
  if (pull.state !== 'open' || pull.draft !== true || pull.head.sha !== stagedIntent) {
    fail('the replacement release pull request is not the expected current draft');
  }
}

export async function reconcileClosedPull({
  event = null,
  repository = REPOSITORY,
  adapter,
  maxAttempts = 5,
}) {
  let wakeUp = event === null ? null : classifyCloseEvent(event, repository);
  if (wakeUp?.action !== undefined && wakeUp.action !== 'regenerate') return wakeUp;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let state;
    try {
      state = await adapter.readState();
    } catch (error) {
      if (error instanceof RetryableStateError) continue;
      throw error;
    }
    assertState(state);

    const lifecyclePulls = selectLifecyclePulls(state.pulls);
    if (wakeUp === null) {
      const latestObserved = lifecyclePulls.at(-1);
      if (!latestObserved) return { action: 'ignored-no-lifecycle' };
      if (latestObserved.state === 'open') {
        assertLifecyclePull(latestObserved);
        return {
          action: 'maintenance-required', pullRequest: latestObserved.number,
          releaseSource: state.releaseSource, intent: state.stagedIntent,
        };
      }
      if (latestObserved.merged === true || latestObserved.merged_at) {
        return { action: 'ignored-merged', pullRequest: latestObserved.number };
      }
      if (latestObserved.state !== 'closed') fail('the latest release pull request has an unexpected state');
      wakeUp = { action: 'regenerate', pullRequest: latestObserved.number, closedHead: latestObserved.head.sha };
    }
    const eventPull = lifecyclePulls.find((pull) => pull.number === wakeUp.pullRequest);
    if (!eventPull) fail('the closed release pull request is absent from durable GitHub state');
    if (eventPull.head.sha !== wakeUp.closedHead) {
      fail('the closed release pull request head changed from the event snapshot');
    }

    const latestPull = lifecyclePulls.at(-1);
    if (!latestPull || latestPull.number < wakeUp.pullRequest) {
      fail('durable GitHub state is missing the current release pull request');
    }

    if (latestPull.state === 'open') {
      assertReplacementPull(latestPull, state.stagedIntent);
      if (!state.stagedCurrent) {
        fail('the open replacement release pull request is based on a stale staged intent');
      }
      return {
        action: 'replacement-exists',
        pullRequest: latestPull.number,
        releaseSource: state.releaseSource,
        intent: state.stagedIntent,
      };
    }

    if (latestPull.merged === true || latestPull.merged_at) {
      return { action: 'ignored-merged', pullRequest: latestPull.number };
    }
    if (latestPull.state !== 'closed') {
      fail('the latest release pull request has an unexpected state');
    }

    if (!state.stagedCurrent || state.stagedIntent === latestPull.head.sha) {
      const intent = await adapter.createFreshIntent({
        source: state.releaseSource,
        previousIntent: state.stagedIntent,
      });
      if (!SHA_PATTERN.test(intent ?? '') || intent === state.stagedIntent) {
        fail('fresh release intent creation did not produce a new commit');
      }

      const beforeWrite = await adapter.readRemoteRefs();
      if (
        beforeWrite.releaseSource !== state.releaseSource ||
        beforeWrite.stagedIntent !== state.stagedIntent
      ) {
        continue;
      }

      const update = buildExpectedOldRefUpdate({
        expectedOld: state.stagedIntent,
        intent,
      });
      await adapter.updateStagedRef(update);

      const afterWrite = await adapter.readRemoteRefs();
      if (
        afterWrite.releaseSource !== state.releaseSource ||
        afterWrite.stagedIntent !== intent
      ) {
        continue;
      }

      // Re-read GitHub and both refs before creating the review surface.
      continue;
    }

    const beforeCreate = await adapter.readRemoteRefs();
    if (
      beforeCreate.releaseSource !== state.releaseSource ||
      beforeCreate.stagedIntent !== state.stagedIntent
    ) {
      continue;
    }

    const body = buildPullRequestBody({
      source: state.releaseSource,
      intent: state.stagedIntent,
      includedCommits: state.includedCommits,
    });
    const request = buildCreatePullRequestRequest({ body });

    try {
      const pull = await adapter.createPull(request);
      assertReplacementPull(pull, state.stagedIntent);
      if (pull.number === wakeUp.pullRequest) {
        fail('GitHub reopened the historical pull request instead of creating a replacement');
      }
      return {
        action: 'created-replacement',
        closedPullRequest: latestPull.number,
        pullRequest: pull.number,
        releaseSource: state.releaseSource,
        intent: state.stagedIntent,
      };
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 422) continue;
      throw error;
    }
  }

  fail('release draft regeneration did not converge after bounded retries');
}

function remoteRefs() {
  const output = git(
    'ls-remote',
    '--exit-code',
    'origin',
    `refs/heads/${RELEASE_LINE}`,
    `refs/heads/${STAGED_LINE}`,
  );
  const refs = new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        if (!SHA_PATTERN.test(sha ?? '')) fail('remote ref has an invalid SHA');
        return [ref, sha];
      }),
  );
  if (refs.size !== 2) fail('expected exactly the release and staged remote refs');
  return {
    releaseSource: refs.get(`refs/heads/${RELEASE_LINE}`),
    stagedIntent: refs.get(`refs/heads/${STAGED_LINE}`),
  };
}

function commitShape(sha) {
  const row = git('rev-list', '--parents', '-n', '1', sha).split(' ');
  return {
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

function validateStagedIntent(staged, source) {
  const shape = commitShape(staged);
  if (shape.parents.length !== 1) fail('staged intent must have exactly one parent');
  const stagedSource = shape.parents[0];
  validateIntent(shape, { source: stagedSource });

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', stagedSource, source], { stdio: 'ignore' });
  } catch {
    fail('staged intent is not based on the current release-line history');
  }
  return stagedSource === source;
}

function includedCommits(baseline, source) {
  const output = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..${source}`);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

function createFreshIntent({ source, previousIntent }) {
  const previousTimestamp = Number(git('show', '-s', '--format=%ct', previousIntent));
  if (!Number.isSafeInteger(previousTimestamp)) fail('previous intent has an invalid timestamp');
  const timestamp = Math.max(Math.floor(Date.now() / 1_000), previousTimestamp + 1);
  const date = new Date(timestamp * 1_000).toISOString();
  const message = buildIntentMessage({ source });
  const intent = execFileSync('git', ['commit-tree', `${source}^{tree}`, '-p', source], {
    encoding: 'utf8',
    input: message,
    env: closedGitEnvironment({
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_DATE: date,
    }),
  }).trim();
  if (intent === previousIntent) fail('new release intent unexpectedly reused the closed intent SHA');
  validateIntent(commitShape(intent), { source });
  return intent;
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
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub API ${options.method ?? 'GET'} ${path} failed with ${response.status}`,
      response.status,
    );
  }
  return body;
}

async function listLifecyclePulls() {
  return readCompletePullHistory({ request: github });
}

async function readDurableState() {
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
  const stagedIntent = git('rev-parse', `refs/remotes/origin/${STAGED_LINE}`);
  const currentRefs = remoteRefs();
  if (
    currentRefs.releaseSource !== releaseSource ||
    currentRefs.stagedIntent !== stagedIntent
  ) {
    throw new RetryableStateError('remote refs changed while durable state was being read');
  }

  const baseline = validateBaseline(releaseSource);
  const stagedCurrent = validateStagedIntent(stagedIntent, releaseSource);
  const pulls = await listLifecyclePulls();
  return {
    releaseSource,
    stagedIntent,
    stagedCurrent,
    includedCommits: includedCommits(baseline, releaseSource),
    pulls,
  };
}

function pushWithToken(args) {
  const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}`;
  return execFileSync('git', ['--no-replace-objects', ...args], {
    encoding: 'utf8',
    env: closedGitEnvironment({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'push.followTags',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_2: authorization,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function workflowAdapter({ rebind }) {
  return {
    readState: readDurableState,
    readRemoteRefs: async () => remoteRefs(),
    createFreshIntent: async (input) => createFreshIntent(input),
    updateStagedRef: async (update) => {
      await rebind();
      pushWithToken(update.pushArgs);
    },
    createPull: async (request) => {
      await rebind();
      return github(`/repos/${REPOSITORY}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) {
    fail(`refusing to write outside ${REPOSITORY}`);
  }
  if (JSON.stringify(argv) !== JSON.stringify(['--if-needed'])) fail('trusted regeneration accepts only --if-needed');
  if (!process.env.GITHUB_EVENT_PATH) fail('GITHUB_EVENT_PATH is required');
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is required');

  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const wakeup = validateMaintainerWakeup({ eventName: process.env.GITHUB_EVENT_NAME, event });
  assertSafeGitConfiguration(process.cwd());
  const rebind = async () => assertTrustedMaintainerMain();
  await rebind();
  const summary = {
    repository: REPOSITORY,
    event: wakeup.event,
    actor: wakeup.actor,
    ...(await reconcileClosedPull({ adapter: workflowAdapter({ rebind }) })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    const maintain = ['maintenance-required', 'ignored-merged'].includes(summary.action);
    await appendFile(process.env.GITHUB_OUTPUT, `maintain=${maintain}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Closed release draft reconciliation\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
