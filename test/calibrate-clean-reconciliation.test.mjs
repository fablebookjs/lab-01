import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  Git,
  NAMESPACE,
  assertCalibrationRef,
  runCalibration,
  scenarioRef,
} from '../scripts/calibrate-clean-reconciliation.mjs';

function command(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-reconciliation-test-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const runner = join(root, 'runner');
  command(root, ['init', '--bare', remote]);
  command(root, ['init', '-b', 'main', seed]);
  command(seed, ['config', 'user.name', 'Test']);
  command(seed, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(seed, 'baseline.txt'), 'baseline\n');
  command(seed, ['add', 'baseline.txt']);
  command(seed, ['commit', '-m', 'baseline'], {
    GIT_AUTHOR_DATE: '2026-07-15T11:00:00Z',
    GIT_COMMITTER_DATE: '2026-07-15T11:00:00Z',
  });
  const source = command(seed, ['rev-parse', 'HEAD']);
  command(seed, ['remote', 'add', 'origin', remote]);
  command(seed, ['push', 'origin', 'main', `${source}:refs/heads/releases/v1.0`, `${source}:refs/heads/staged/v1.0`]);
  command(root, ['clone', remote, runner]);
  command(runner, ['checkout', 'main']);
  return {
    root,
    remote,
    runner,
    source,
    git: new Git({ cwd: runner, remote }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function remoteRef(f, ref) {
  return command(f.runner, ['ls-remote', '--heads', f.remote, ref]).split(/\s+/)[0] || null;
}

function parents(f, sha) {
  return command(f.runner, ['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

for (const [scenario, expectedRole] of [
  ['no-late', 'v'],
  ['clean-late', 'j'],
  ['concurrent-head', 'h2'],
]) {
  test(`${scenario} converges to its exact fixed graph and reruns safely`, () => {
    const f = fixture();
    try {
      const first = runCalibration({ scenario, git: f.git, source: f.source });
      const second = runCalibration({ scenario, git: f.git, source: f.source });
      assert.equal(first.finalHead, first.graph[expectedRole]);
      assert.equal(second.finalHead, first.finalHead);
      assert.equal(remoteRef(f, first.lineRef), first.finalHead);
      assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
      assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);

      if (scenario === 'no-late') {
        assert.deepEqual(parents(f, first.graph.v), [first.graph.m]);
      } else {
        assert.deepEqual(parents(f, first.graph.j), [first.graph.h, first.graph.v]);
        assert.equal(
          command(f.runner, ['show', `${first.graph.j}:calibration/g1/reconciliation/${scenario}/late.txt`]),
          'late work for the next patch',
        );
        assert.equal(
          command(f.runner, ['show', `${first.graph.j}:calibration/g1/reconciliation/${scenario}/version.txt`]),
          '1.0.1',
        );
      }

      if (scenario === 'concurrent-head') {
        assert.equal(first.outcome, 'stale-reconciliation-rejected');
        assert.equal(first.stalePushRejected, true);
        assert.equal(second.outcome, 'reused-concurrent-rejection');
        assert.deepEqual(parents(f, first.graph.h2), [first.graph.h]);
      }

      const unexpected = command(f.runner, ['ls-remote', '--heads', f.remote])
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[1])
        .filter((ref) => !['refs/heads/main', 'refs/heads/releases/v1.0', 'refs/heads/staged/v1.0'].includes(ref));
      assert.ok(unexpected.every((ref) => ref.startsWith(`${NAMESPACE}/${scenario}/`)));
    } finally {
      f.cleanup();
    }
  });
}

test('an incompatible fixed ref fails closed without moving the release sentinels', () => {
  const f = fixture();
  try {
    command(f.runner, ['push', f.remote, `${f.source}:${scenarioRef('no-late', 'v')}`]);
    assert.throws(
      () => runCalibration({ scenario: 'no-late', git: f.git, source: f.source }),
      /Fixed calibration ref .* is .* expected/,
    );
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('forbidden scenarios and refs fail before a Git write', () => {
  assert.throws(() => scenarioRef('conflict', 'line'), /Unsupported scenario/);
  assert.throws(() => assertCalibrationRef('refs/heads/releases/v1.0'), /outside/);
  assert.throws(() => assertCalibrationRef(`${NAMESPACE}/../releases/v1.0`), /outside/);
});

test('the workflow is manual, main-bound, and has only contents write authority', () => {
  const workflow = readFileSync(new URL('../.github/workflows/calibrate-clean-reconciliation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /persist-credentials: true/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /pull-requests:|issues:|packages:|secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /releases\/v1\.0|staged\/v1\.0/);
});
