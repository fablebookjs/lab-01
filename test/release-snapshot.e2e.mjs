import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareReleaseSnapshot } from '../scripts/prepare-release-snapshot.mjs';
import { RELEASE_LINE, REPOSITORY, SNAPSHOT_REF } from '../scripts/release-publication.mjs';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
    ...options,
  }).trim();
}

test('full trusted preparation regenerates expired QA and converges across equivalent runs', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'lab-01-snapshot-e2e-'));
  const repoRoot = join(temporary, 'repository');
  const previous = { ...process.env };
  try {
    git(temporary, ['clone', '--quiet', '--no-local', process.cwd(), repoRoot]);
    git(repoRoot, ['remote', 'set-url', 'origin', 'https://github.com/fablebookjs/lab-01.git']);
    const sourceSha = git(repoRoot, ['rev-parse', 'HEAD']);
    const sourceTree = git(repoRoot, ['rev-parse', `${sourceSha}^{tree}`]);
    const intentMessage = `release: propose v1.0.1\n\nRelease-Intent-Version: 1\nRelease-Line: releases/v1.0\nRelease-Version: 1.0.1\nRelease-Source: ${sourceSha}\n`;
    const stagedSha = git(repoRoot, ['commit-tree', sourceTree, '-p', sourceSha], { input: intentMessage });
    const mergeSha = git(repoRoot, ['commit-tree', sourceTree, '-p', sourceSha, '-p', stagedSha, '-m', 'merge release intent']);
    const pull = {
      id: 12,
      number: 12,
      state: 'closed',
      draft: false,
      merged: true,
      merged_at: '2026-07-16T10:00:00Z',
      merge_commit_sha: mergeSha,
      base: { repo: { full_name: REPOSITORY }, ref: RELEASE_LINE, sha: sourceSha },
      head: { repo: { full_name: REPOSITORY }, ref: 'staged/v1.0', sha: stagedSha },
    };
    const runs = [
      { id: 99, name: 'Ready release QA controller', created_at: '2026-07-16T10:01:00Z', status: 'completed', conclusion: 'success', path: '.github/workflows/ready-release-qa-controller.yml', head_branch: 'main', head_sha: sourceSha, event: 'workflow_run', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, artifact_names: [`ready-release-qa-${stagedSha}`] },
    ];
    const refs = new Map([
      ['refs/heads/main', sourceSha],
      [`refs/heads/${RELEASE_LINE}`, mergeSha],
      [SNAPSHOT_REF, null],
    ]);
    const adapter = {
      pull: async () => structuredClone(pull),
      releasePulls: async () => [structuredClone(pull)],
      qaRuns: async () => structuredClone(runs),
      artifacts: async () => ({ total_count: 1, artifacts: [{ id: 7, expired: true }] }),
      ref: async (_root, ref) => refs.get(ref) ?? null,
      fetchObjects: async () => {},
      pushSnapshot: async (_root, sha) => { refs.set(SNAPSHOT_REF, sha); },
    };
    Object.assign(process.env, {
      EXPECTED_DISPATCH_SHA: sourceSha,
      EXPECTED_WORKFLOW_SHA: sourceSha,
      GITHUB_REF: 'refs/heads/main',
      LAB_01_TRUSTED_TOOL_ROOT: process.cwd(),
    });
    const firstPath = join(temporary, 'first.json');
    const first = await prepareReleaseSnapshot({
      repoRoot,
      prNumber: '12',
      qaRunExpectation: '99',
      evidencePath: firstPath,
      adapter,
      temporaryBase: temporary,
    });
    assert.equal(first.snapshot.result, 'created');
    assert.equal(first.authorization.retainedArtifactAvailable, false);
    assert.deepEqual(JSON.parse(await readFile(firstPath, 'utf8')), first);

    runs.push({ ...runs[0], id: 100, created_at: '2026-07-16T10:02:00Z', event: 'workflow_dispatch' });
    const second = await prepareReleaseSnapshot({
      repoRoot,
      prNumber: '12',
      qaRunExpectation: '100',
      evidencePath: join(temporary, 'second.json'),
      adapter,
      temporaryBase: temporary,
    });
    assert.equal(second.snapshot.result, 'reused');
    assert.equal(second.snapshot.sha, first.snapshot.sha);
    assert.equal(second.snapshot.tree, first.snapshot.tree);
    assert.notEqual(second.authorization.latestSuccessfulQaRun, first.authorization.latestSuccessfulQaRun);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(temporary, { recursive: true, force: true });
  }
});
