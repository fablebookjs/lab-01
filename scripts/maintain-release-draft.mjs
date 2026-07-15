import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'fablebookjs/lab-01';
const RELEASE_LINE = 'releases/v1.0';
const STAGED_LINE = 'staged/v1.0';
const BASELINE_TAG = 'v1.0.0';
const RELEASE_VERSION = '1.0.1';
const INTENT_VERSION = '1';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const git = (...args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const fail = (message) => {
  throw new Error(message);
};

export function parseIntentMessage(message) {
  const lines = message.trimEnd().split('\n');
  const subject = lines.shift();
  const trailers = new Map();

  for (const line of lines) {
    if (line === '') continue;
    const match = /^([A-Za-z0-9-]+): (.+)$/.exec(line);
    if (!match || trailers.has(match[1])) {
      fail(`invalid or duplicate release-intent trailer: ${line}`);
    }
    trailers.set(match[1], match[2]);
  }

  return { subject, trailers };
}

export function validateIntent(
  { message, parents, commitTree, parentTree },
  { source, line = RELEASE_LINE, version = RELEASE_VERSION } = {},
) {
  if (!SHA_PATTERN.test(source ?? '')) fail('release intent has an invalid expected source SHA');
  if (parents.length !== 1) fail('release intent must have exactly one parent');
  if (parents[0] !== source) fail('release intent parent does not equal its source');
  if (commitTree !== parentTree) fail('release intent changes the source tree');

  const { subject, trailers } = parseIntentMessage(message);
  const expected = new Map([
    ['Release-Intent-Version', INTENT_VERSION],
    ['Release-Line', line],
    ['Release-Version', version],
    ['Release-Source', source],
  ]);

  if (subject !== `release: propose v${version}`) fail('release intent has an unexpected subject');
  if (trailers.size !== expected.size) fail('release intent has unexpected trailers');
  for (const [key, value] of expected) {
    if (trailers.get(key) !== value) fail(`release intent has an invalid ${key} trailer`);
  }
}

export function buildPullRequestBody({ source, intent, includedCommits }) {
  const commits =
    includedCommits.length === 0
      ? '- None; the proposed source is the `v1.0.0` baseline.'
      : includedCommits.map(({ sha, subject }) => `- \`${sha}\` ${subject}`).join('\n');

  return `## Release intent

- Release line: \`${RELEASE_LINE}\`
- Proposed version: \`${RELEASE_VERSION}\`
- Exact release source: \`${source}\`
- Structured intent commit: \`${intent}\`

The structured empty commit is authoritative. This editable title and body are presentation only.

## Included commits since \`${BASELINE_TAG}\`

${commits}

## Current lifecycle state

Automatic draft maintenance is live. A push to \`${RELEASE_LINE}\` refreshes this same draft PR from the exact new release-line head while preserving its number, base, head, and draft state.

Ready-state QA, close-and-regenerate behavior, publication, branch reconciliation, a \`v1.0.1\` tag, and a GitHub Release are not implemented. Do not merge this release PR.

See [docs/release-process.md](https://github.com/${REPOSITORY}/blob/${RELEASE_LINE}/docs/release-process.md) for the current contract and safety boundary.`;
}

function refSha(ref) {
  const output = git('ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`);
  const rows = output.split('\n').filter(Boolean);
  if (rows.length !== 1) fail(`expected exactly one remote ${ref} ref`);
  const [sha, name] = rows[0].split(/\s+/);
  if (!SHA_PATTERN.test(sha) || name !== `refs/heads/${ref}`) fail(`unexpected remote ${ref} ref`);
  return sha;
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

function validateExistingStagedIntent(staged, source) {
  const shape = commitShape(staged);
  if (shape.parents.length !== 1) fail('existing staged intent must have exactly one parent');
  const stagedSource = shape.parents[0];
  validateIntent(shape, { source: stagedSource });

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', stagedSource, source], { stdio: 'ignore' });
  } catch {
    fail('existing staged intent is not based on the current release-line history');
  }
  return stagedSource === source;
}

function createIntent(source) {
  const message = `release: propose v${RELEASE_VERSION}\n\nRelease-Intent-Version: ${INTENT_VERSION}\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${RELEASE_VERSION}\nRelease-Source: ${source}\n`;
  return execFileSync('git', ['commit-tree', `${source}^{tree}`, '-p', source], {
    encoding: 'utf8',
    input: message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    },
  }).trim();
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
  if (!response.ok) fail(`GitHub API ${options.method ?? 'GET'} ${path} failed with ${response.status}`);
  return body;
}

function assertMatchingDraft(pull) {
  if (
    pull.state !== 'open' ||
    pull.draft !== true ||
    pull.base?.ref !== RELEASE_LINE ||
    pull.base?.repo?.full_name !== REPOSITORY ||
    pull.head?.ref !== STAGED_LINE ||
    pull.head?.repo?.full_name !== REPOSITORY
  ) {
    fail('the matching release PR is not the expected open draft');
  }
}

async function findDraftPull() {
  const pulls = await github(
    `/repos/${REPOSITORY}/pulls?state=open&base=${encodeURIComponent(RELEASE_LINE)}&per_page=100`,
  );
  const matching = pulls.filter(
    (pull) => pull.head?.ref === STAGED_LINE && pull.head?.repo?.full_name === REPOSITORY,
  );
  if (matching.length !== 1) fail(`expected one matching open release PR, found ${matching.length}`);
  assertMatchingDraft(matching[0]);
  return matching[0];
}

async function waitForPullHead(pullNumber, intent) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const pull = await github(`/repos/${REPOSITORY}/pulls/${pullNumber}`);
    assertMatchingDraft(pull);
    if (pull.head.sha === intent) return pull;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  fail('release PR did not converge on the current staged intent');
}

function includedCommits(baseline, source) {
  const output = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..${source}`);
  if (!output) return [];
  return output.split('\n').map((line) => {
    const separator = line.indexOf('\t');
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

export async function main({ dryRun = process.argv.includes('--dry-run') } = {}) {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) {
    fail(`refusing to write outside ${REPOSITORY}`);
  }
  if (!process.env.GITHUB_TOKEN) fail('GITHUB_TOKEN is required');

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
  const previousIntent = git('rev-parse', `refs/remotes/origin/${STAGED_LINE}`);
  if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== previousIntent) {
    fail('remote refs changed while reading state; a later wake-up must reconcile them');
  }

  const pull = await findDraftPull();
  if (pull.head.sha !== previousIntent) fail('release PR head does not equal the staged ref');

  const baseline = validateBaseline(releaseSource);
  const alreadyCurrent = validateExistingStagedIntent(previousIntent, releaseSource);
  let intent = previousIntent;

  if (!alreadyCurrent && !dryRun) {
    intent = createIntent(releaseSource);
    validateIntent(commitShape(intent), { source: releaseSource });

    if (refSha(RELEASE_LINE) !== releaseSource) {
      fail('release line advanced before the guarded staged write; a later wake-up must win');
    }
    if (refSha(STAGED_LINE) !== previousIntent) {
      fail('staged ref advanced before the guarded staged write; refusing to overwrite it');
    }

    git(
      'push',
      `--force-with-lease=refs/heads/${STAGED_LINE}:${previousIntent}`,
      'origin',
      `${intent}:refs/heads/${STAGED_LINE}`,
    );

    if (refSha(RELEASE_LINE) !== releaseSource || refSha(STAGED_LINE) !== intent) {
      fail('remote refs did not match the guarded staged update');
    }
  }

  const commits = includedCommits(baseline, releaseSource);
  if (!dryRun) {
    await waitForPullHead(pull.number, intent);

    const body = buildPullRequestBody({ source: releaseSource, intent, includedCommits: commits });
    await github(`/repos/${REPOSITORY}/pulls/${pull.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  const summary = {
    repository: REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    actor: process.env.GITHUB_ACTOR ?? 'local',
    pullRequest: pull.number,
    action: alreadyCurrent
      ? dryRun
        ? 'would-reuse-current-intent'
        : 'reused-current-intent'
      : dryRun
        ? 'would-refresh-intent'
        : 'refreshed-intent',
    releaseSource,
    previousIntent,
    intent: alreadyCurrent || !dryRun ? intent : null,
    includedCommits: commits.map(({ sha }) => sha),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Draft release maintenance\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
