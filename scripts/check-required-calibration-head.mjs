import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Git,
  REPOSITORY,
  assertSha,
  calibrationRef,
} from './calibrate-required-check-state.mjs';

export function evaluateRequiredHead({ git = new Git(), headSha, authorizedSha }) {
  assertSha(headSha);
  assertSha(authorizedSha);
  git.assertNoHostileEnvironment();
  git.assertTrustedRemote();
  const localHead = git.text(['rev-parse', 'HEAD']);
  if (localHead !== headSha) {
    throw new Error(`Local HEAD ${localHead} is not dispatched SHA ${headSha}`);
  }

  const headRef = calibrationRef('head');
  const remoteHead = git.remoteRef(headRef);
  const authorized = remoteHead === headSha && authorizedSha === headSha;
  const reason = remoteHead !== headSha
    ? 'dispatched-sha-is-not-current-remote-head'
    : authorizedSha !== headSha
      ? 'dispatched-sha-is-not-authorized'
      : 'current-head-matches-authorized-sha';
  return { authorized, reason, headSha, authorizedSha, localHead, remoteHead };
}

export function buildCheckSummary(result) {
  return (
    `## G1 required current-head check\n\n` +
    `- Result: \`${result.authorized ? 'authorized' : 'rejected'}\`\n` +
    `- Reason: \`${result.reason}\`\n` +
    `- Dispatched SHA: \`${result.headSha}\`\n` +
    `- Authorized SHA input: \`${result.authorizedSha}\`\n` +
    `- Remote head: \`${result.remoteHead ?? 'absent'}\`\n` +
    `- Permission used: \`contents: read\` only\n`
  );
}

function assertLiveContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Wrong GitHub repository');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Wrong GitHub event');
  if (process.env.GITHUB_REF !== calibrationRef('head')) {
    throw new Error(`Required check must dispatch from ${calibrationRef('head')}`);
  }
  assertSha(process.env.GITHUB_SHA);
}

async function main() {
  assertLiveContext();
  const authorizedIndex = process.argv.indexOf('--authorized-sha');
  const authorizedSha = authorizedIndex === -1 ? null : process.argv[authorizedIndex + 1];
  const result = evaluateRequiredHead({ headSha: process.env.GITHUB_SHA, authorizedSha });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, buildCheckSummary(result));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.authorized) {
    throw new Error(`Required calibration head rejected: ${result.reason}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
