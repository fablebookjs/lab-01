import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import {
  Git,
  REPOSITORY,
  assertSha,
  calibrationRef,
  parseRemoteAdvertisement,
} from './calibrate-required-check-state.mjs';

export const AUTHORIZATION_PREFIX = 'Authorized-Head-SHA:';
export const PULL_REQUEST_ACTIONS = ['opened', 'synchronize', 'reopened', 'edited'];
export const PROTECTED_PULL_REQUESTS = new Set([12, 16, 19]);

const BRANCH_NAMESPACE = 'calibration/g1/required-check-pr';
const BASE_REF = `${BRANCH_NAMESPACE}/base`;
const HEAD_REF = `${BRANCH_NAMESPACE}/head`;
const MAX_EVENT_BYTES = 1024 * 1024;

function requireObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireExact(value, expected, description) {
  if (value !== expected) throw new Error(`${description} must be exact ${expected}`);
}

export function parseAuthorizedHead(body) {
  if (typeof body !== 'string') throw new Error('Pull request body must be a string');
  const candidates = body
    .split(/\r?\n/)
    .filter((line) => line.includes(AUTHORIZATION_PREFIX));
  if (candidates.length !== 1) {
    throw new Error('Pull request body must contain one exact Authorized-Head-SHA line');
  }
  const match = candidates[0].match(/^Authorized-Head-SHA: ([0-9a-f]{40})$/);
  if (!match) throw new Error('Malformed Authorized-Head-SHA line');
  return match[1];
}

export function readPullRequestEvent(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new Error('GITHUB_EVENT_PATH must identify one event file');
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error('GITHUB_EVENT_PATH must be a readable regular non-symlink file');
  }
  let raw;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error('GITHUB_EVENT_PATH must be a regular non-symlink file');
    }
    if (metadata.size <= 0 || metadata.size > MAX_EVENT_BYTES) {
      throw new Error('GitHub event payload has an unsafe size');
    }
    raw = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(raw) !== metadata.size || fstatSync(descriptor).size !== metadata.size) {
      throw new Error('GitHub event payload changed while being read');
    }
  } finally {
    closeSync(descriptor);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GitHub event payload is not valid JSON');
  }
  return requireObject(parsed, 'GitHub event payload');
}

function assertActionCoherence(event, action, headSha, body) {
  if (action === 'synchronize') {
    assertSha(event.before);
    assertSha(event.after);
    if (event.before === event.after) throw new Error('Synchronize event must change the head SHA');
    if (event.after !== headSha) throw new Error('Synchronize event after SHA is not current PR head');
    return;
  }
  if (Object.hasOwn(event, 'before') || Object.hasOwn(event, 'after')) {
    throw new Error(`${action} event must not carry synchronize SHA fields`);
  }
  if (action === 'edited') {
    const changes = requireObject(event.changes, 'Edited event changes');
    const bodyChange = requireObject(changes.body, 'Edited event body change');
    if (typeof bodyChange.from !== 'string' || bodyChange.from === body) {
      throw new Error('Edited event must carry a changed prior pull request body');
    }
  } else if (Object.hasOwn(event, 'changes')) {
    throw new Error(`${action} event must not carry edited change fields`);
  }
}

export function evaluatePullRequestHead({
  git = new Git(),
  event,
  repository,
  eventName,
  githubRef,
  githubSha,
  baseRef,
  headRef,
}) {
  requireExact(repository, REPOSITORY, 'GITHUB_REPOSITORY');
  requireExact(eventName, 'pull_request', 'GITHUB_EVENT_NAME');
  assertSha(githubSha);
  event = requireObject(event, 'GitHub event payload');
  if (!PULL_REQUEST_ACTIONS.includes(event.action)) throw new Error('Unsupported pull request action');
  requireExact(requireObject(event.repository, 'Event repository').full_name, REPOSITORY, 'Event repository');

  const pullRequest = requireObject(event.pull_request, 'Pull request');
  const number = event.number;
  if (!Number.isSafeInteger(number) || number <= 0 || pullRequest.number !== number) {
    throw new Error('Pull request identity must be one matching positive integer');
  }
  if (PROTECTED_PULL_REQUESTS.has(number)) throw new Error(`Pull request #${number} is protected evidence`);
  requireExact(githubRef, `refs/pull/${number}/merge`, 'GITHUB_REF');
  requireExact(baseRef, BASE_REF, 'GITHUB_BASE_REF');
  requireExact(headRef, HEAD_REF, 'GITHUB_HEAD_REF');
  requireExact(pullRequest.state, 'open', 'Pull request state');
  requireExact(pullRequest.draft, false, 'Pull request draft state');
  requireExact(pullRequest.merged, false, 'Pull request merged state');
  requireExact(pullRequest.merged_at, null, 'Pull request merged_at');

  const base = requireObject(pullRequest.base, 'Pull request base');
  const head = requireObject(pullRequest.head, 'Pull request head');
  requireExact(base.ref, BASE_REF, 'Pull request base ref');
  requireExact(head.ref, HEAD_REF, 'Pull request head ref');
  requireExact(requireObject(base.repo, 'Pull request base repository').full_name, REPOSITORY, 'Base repository');
  requireExact(requireObject(head.repo, 'Pull request head repository').full_name, REPOSITORY, 'Head repository');
  assertSha(base.sha);
  assertSha(head.sha);
  assertActionCoherence(event, event.action, head.sha, pullRequest.body);

  git.assertNoHostileEnvironment();
  git.assertTrustedRemote();
  const baseRemoteRef = calibrationRef('base');
  const headRemoteRef = calibrationRef('head');
  const mergeRemoteRef = `refs/pull/${number}/merge`;
  const remoteRefs = [baseRemoteRef, headRemoteRef, mergeRemoteRef];
  const advertisement = parseRemoteAdvertisement(
    git.text(['ls-remote', '--refs', git.remote, ...remoteRefs], { network: true }),
    remoteRefs,
  );
  for (const ref of remoteRefs) {
    if (advertisement[ref] === null) throw new Error(`Required remote ref is absent: ${ref}`);
  }
  if (advertisement[baseRemoteRef] !== base.sha) {
    throw new Error('Event base SHA is not the current remote calibration base');
  }
  if (advertisement[headRemoteRef] !== head.sha) {
    throw new Error('Event head SHA is not the current remote calibration head');
  }
  if (advertisement[mergeRemoteRef] !== githubSha) {
    throw new Error('GITHUB_SHA is not the current remote pull request merge ref');
  }
  const localHead = git.text(['rev-parse', 'HEAD']);
  if (localHead !== base.sha) {
    throw new Error(`Local HEAD ${localHead} is not trusted event base SHA ${base.sha}`);
  }

  const authorizedSha = parseAuthorizedHead(pullRequest.body);
  const authorized = authorizedSha === head.sha;
  return {
    authorized,
    reason: authorized ? 'pr-body-authorizes-current-head' : 'pr-body-does-not-authorize-current-head',
    action: event.action,
    number,
    baseSha: base.sha,
    headSha: head.sha,
    authorizedSha,
    localHead,
    remoteBaseSha: advertisement[baseRemoteRef],
    remoteHeadSha: advertisement[headRemoteRef],
    remoteMergeSha: advertisement[mergeRemoteRef],
  };
}

export function buildCheckSummary(result) {
  return (
    `## G1 required current-head PR check\n\n` +
    `- Result: \`${result.authorized ? 'authorized' : 'rejected'}\`\n` +
    `- Reason: \`${result.reason}\`\n` +
    `- Pull request: \`#${result.number}\`\n` +
    `- Event action: \`${result.action}\`\n` +
    `- Trusted base SHA: \`${result.baseSha}\`\n` +
    `- Current head SHA: \`${result.headSha}\`\n` +
    `- PR-body authorized SHA: \`${result.authorizedSha}\`\n` +
    `- Current remote merge SHA: \`${result.remoteMergeSha}\`\n` +
    `- Permission used: \`contents: read\` only\n`
  );
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  const event = readPullRequestEvent(process.env.GITHUB_EVENT_PATH);
  const result = evaluatePullRequestHead({
    event,
    repository: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME,
    githubRef: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
    baseRef: process.env.GITHUB_BASE_REF,
    headRef: process.env.GITHUB_HEAD_REF,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, buildCheckSummary(result));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.authorized) throw new Error(`Required calibration head rejected: ${result.reason}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
