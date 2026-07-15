import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FILE_PATH,
  Git,
  INTENTIONAL_FAILURE_EXIT_CODE,
  NAMESPACE,
  assertConflictRef,
  conflictRef,
  createGraph,
  finalizeResult,
  pushWithLease,
  recoveryPullRequestBody,
  runConflictRecovery,
  verifyGraph,
} from '../scripts/calibrate-conflict-recovery.mjs';

function command(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', ...env },
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-conflict-recovery-test-'));
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
  command(seed, [
    'push',
    'origin',
    'main',
    `${source}:refs/heads/releases/v1.0`,
    `${source}:refs/heads/staged/v1.0`,
  ]);
  command(root, ['clone', remote, runner]);
  command(runner, ['checkout', 'main']);
  return {
    root,
    remote,
    runner,
    source,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function remoteRef(f, ref) {
  const output = command(f.runner, ['ls-remote', '--heads', f.remote, ref]);
  return output ? output.split(/\s+/)[0] : null;
}

function parents(f, sha) {
  return command(f.runner, ['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

function tree(f, sha) {
  return command(f.runner, ['show', '-s', '--format=%T', sha]);
}

class RecordingGit extends Git {
  constructor(options) {
    super(options);
    this.pushes = [];
  }

  run(args, options) {
    if (args[0] === 'push') this.pushes.push([...args]);
    return super.run(args, options);
  }
}

function pullFor(graph, input, number = 101) {
  return {
    number,
    html_url: `https://github.com/fablebookjs/lab-01/pull/${number}`,
    state: 'open',
    draft: true,
    title: input.title,
    body: input.body,
    base: {
      ref: input.base,
      sha: graph.v,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
    head: {
      ref: input.head,
      sha: graph.h,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
  };
}

class FakeGitHub {
  constructor(graph) {
    this.graph = graph;
    this.pulls = [];
    this.listCalls = [];
    this.createCalls = [];
  }

  async listOpenPullRequests(filter) {
    this.listCalls.push(filter);
    return structuredClone(this.pulls);
  }

  async createPullRequest(input) {
    this.createCalls.push(input);
    const pull = pullFor(this.graph, input);
    this.pulls.push(pull);
    return structuredClone(pull);
  }
}

test('inject-after-force creates the exact conflicting graph, backs up H first, and never plans a PR', async () => {
  const f = fixture();
  try {
    const git = new RecordingGit({ cwd: f.runner, remote: f.remote });
    const github = {
      async listOpenPullRequests() {
        throw new Error('inject mode must not query pull requests');
      },
      async createPullRequest() {
        throw new Error('inject mode must not create pull requests');
      },
    };
    const first = await runConflictRecovery({
      mode: 'inject-after-force',
      git,
      source: f.source,
      github,
    });

    assert.equal(first.intentionalFailure, true);
    assert.equal(first.failurePoint, 'after-durable-force-before-pr');
    assert.deepEqual(parents(f, first.graph.intent), [first.graph.source]);
    assert.equal(tree(f, first.graph.intent), tree(f, first.graph.source));
    assert.deepEqual(parents(f, first.graph.m), [first.graph.source, first.graph.intent]);
    assert.equal(tree(f, first.graph.m), tree(f, first.graph.source));
    assert.deepEqual(parents(f, first.graph.v), [first.graph.m]);
    assert.deepEqual(parents(f, first.graph.h), [first.graph.m]);
    assert.equal(command(f.runner, ['show', `${first.graph.v}:${FILE_PATH}`]), 'release snapshot for 1.0.1');
    assert.equal(
      command(f.runner, ['show', `${first.graph.h}:${FILE_PATH}`]),
      'complete late work for the recovery patch',
    );
    const merge = spawnSync('git', ['merge-tree', '--write-tree', first.graph.v, first.graph.h], {
      cwd: f.runner,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    assert.notEqual(merge.status, 0);
    assert.match(merge.stdout, new RegExp(`CONFLICT \\(add/add\\): Merge conflict in ${FILE_PATH}`));

    assert.equal(remoteRef(f, first.backupRef), first.graph.h);
    assert.equal(remoteRef(f, first.lineRef), first.graph.v);
    assert.deepEqual(first.lateCommits, [first.graph.h]);
    assert.equal(command(f.runner, ['merge-base', '--is-ancestor', first.graph.h, first.remoteBackup]), '');
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);

    const backupPush = git.pushes.findIndex((args) => args.at(-1) === `${first.graph.h}:${first.backupRef}`);
    const forcePush = git.pushes.findIndex(
      (args) =>
        args.includes(`--force-with-lease=${first.lineRef}:${first.graph.h}`) &&
        args.at(-1) === `${first.graph.v}:${first.lineRef}`,
    );
    assert.ok(backupPush !== -1 && forcePush !== -1 && backupPush < forcePush);

    const refs = command(f.runner, ['ls-remote', '--heads', f.remote])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1]);
    const calibrationRefs = refs.filter((ref) => ref.startsWith('refs/heads/calibration/'));
    assert.deepEqual(
      calibrationRefs.sort(),
      ['source', 'intent', 'm', 'v', 'h', 'backup', 'line'].map(conflictRef).sort(),
    );

    const pushesBeforeRerun = git.pushes.length;
    const rerun = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source, github });
    assert.equal(rerun.intentionalFailure, true);
    assert.equal(rerun.forceResult, 'reused-release-snapshot');
    assert.deepEqual(rerun.graph, first.graph);
    assert.equal(git.pushes.length, pushesBeforeRerun);
  } finally {
    f.cleanup();
  }
});

test('a partial failure after creating line H converges without changing graph identities', async () => {
  const f = fixture();
  try {
    class FailBackupOnceGit extends Git {
      failed = false;

      run(args, options) {
        if (!this.failed && args[0] === 'push' && args.at(-1)?.endsWith(`:${conflictRef('backup')}`)) {
          this.failed = true;
          return { status: 1, stdout: '', stderr: 'simulated backup transport failure' };
        }
        return super.run(args, options);
      }
    }

    const interruptedGit = new FailBackupOnceGit({ cwd: f.runner, remote: f.remote });
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git: interruptedGit, source: f.source }),
      /simulated backup transport failure/,
    );
    const expected = createGraph(interruptedGit, f.source);
    assert.equal(remoteRef(f, conflictRef('line')), expected.h);
    assert.equal(remoteRef(f, conflictRef('backup')), null);

    const resumed = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git({ cwd: f.runner, remote: f.remote }),
      source: f.source,
    });
    assert.deepEqual(resumed.graph, expected);
    assert.equal(resumed.backupResult, 'created');
    assert.equal(resumed.forceResult, 'forced-h-to-v');
    assert.equal(remoteRef(f, resumed.backupRef), expected.h);
    assert.equal(remoteRef(f, resumed.lineRef), expected.v);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('resume forces an H line only after verifying the backup, creates one draft PR, then reuses it', async () => {
  const f = fixture();
  try {
    const setupGit = new Git({ cwd: f.runner, remote: f.remote });
    const injected = await runConflictRecovery({
      mode: 'inject-after-force',
      git: setupGit,
      source: f.source,
    });
    command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);

    const git = new RecordingGit({ cwd: f.runner, remote: f.remote });
    const github = new FakeGitHub(injected.graph);
    const first = await runConflictRecovery({ mode: 'resume', git, source: f.source, github });
    assert.equal(first.forceResult, 'forced-h-to-v');
    assert.equal(first.outcome, 'recovery-pr-created');
    assert.equal(first.pullRequest.number, 101);
    assert.equal(first.pullRequest.draft, true);
    assert.equal(remoteRef(f, first.lineRef), first.graph.v);
    assert.equal(remoteRef(f, first.backupRef), first.graph.h);
    assert.equal(github.createCalls.length, 1);
    assert.deepEqual(github.createCalls[0], {
      title: 'Recover conflict calibration work after 1.0.1',
      body: recoveryPullRequestBody(first.graph),
      base: 'calibration/g1/conflict-recovery/line',
      head: 'calibration/g1/conflict-recovery/backup',
      draft: true,
    });
    assert.match(github.createCalls[0].body, new RegExp(first.graph.h));
    assert.match(github.createCalls[0].body, /@ndelangen/);
    assert.match(github.createCalls[0].body, /missed 1\.0\.1; another patch is required/);
    assert.match(github.createCalls[0].body, /conflicts must be resolved/);
    assert.ok(github.listCalls.every((call) => call.head === 'fablebookjs:calibration/g1/conflict-recovery/backup'));

    const pushesBeforeRerun = git.pushes.length;
    const second = await runConflictRecovery({ mode: 'resume', git, source: f.source, github });
    assert.equal(second.outcome, 'recovery-pr-reused');
    assert.equal(second.forceResult, 'reused-release-snapshot');
    assert.equal(second.pullRequest.number, first.pullRequest.number);
    assert.equal(github.createCalls.length, 1);
    assert.equal(git.pushes.length, pushesBeforeRerun);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('resume rejects missing evidence and incompatible fixed refs or topology without a PR', async () => {
  const f = fixture();
  try {
    const git = new Git({ cwd: f.runner, remote: f.remote });
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: new FakeGitHub({}) }),
      /line .* absent/,
    );

    command(f.runner, ['push', '--force', f.remote, `${f.source}:${conflictRef('v')}`]);
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git, source: f.source }),
      /Fixed conflict calibration ref .* expected/,
    );

    const graph = createGraph(git, f.source);
    assert.throws(() => verifyGraph(git, { ...graph, h: graph.v }), /H is not the complete fixed late-work head/);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('a stale expected-H lease fails closed and does not create a PR', async () => {
  const f = fixture();
  try {
    const setupGit = new Git({ cwd: f.runner, remote: f.remote });
    const injected = await runConflictRecovery({
      mode: 'inject-after-force',
      git: setupGit,
      source: f.source,
    });
    command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);

    class RacingGit extends Git {
      raced = false;

      run(args, options) {
        const lease = `--force-with-lease=${injected.lineRef}:${injected.graph.h}`;
        if (!this.raced && args[0] === 'push' && args.includes(lease)) {
          this.raced = true;
          command(f.runner, ['push', '--force', f.remote, `${injected.graph.m}:${injected.lineRef}`]);
        }
        return super.run(args, options);
      }
    }

    const github = new FakeGitHub(injected.graph);
    await assert.rejects(
      runConflictRecovery({
        mode: 'resume',
        git: new RacingGit({ cwd: f.runner, remote: f.remote }),
        source: f.source,
        github,
      }),
      /Expected-H force-with-lease .* was rejected/,
    );
    assert.equal(github.createCalls.length, 0);
    assert.equal(remoteRef(f, injected.lineRef), injected.graph.m);
    assert.equal(remoteRef(f, injected.backupRef), injected.graph.h);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('GitHub refusal, duplicate recovery PRs, and PR #12 all fail closed', async () => {
  const f = fixture();
  try {
    const git = new Git({ cwd: f.runner, remote: f.remote });
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    const input = {
      title: 'Recover conflict calibration work after 1.0.1',
      body: recoveryPullRequestBody(injected.graph),
      base: 'calibration/g1/conflict-recovery/line',
      head: 'calibration/g1/conflict-recovery/backup',
      draft: true,
    };

    const refused = {
      createCalls: 0,
      async listOpenPullRequests() {
        return [];
      },
      async createPullRequest() {
        this.createCalls += 1;
        throw new Error('GitHub refused synthetic PR creation');
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: refused }),
      /GitHub refused synthetic PR creation/,
    );
    assert.equal(refused.createCalls, 1);

    const duplicate = {
      async listOpenPullRequests() {
        return [pullFor(injected.graph, input, 101), pullFor(injected.graph, input, 102)];
      },
      async createPullRequest() {
        throw new Error('must not create a third PR');
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: duplicate }),
      /More than one open recovery PR/,
    );

    const protectedPr = {
      async listOpenPullRequests() {
        return [pullFor(injected.graph, input, 12)];
      },
      async createPullRequest() {
        throw new Error('must not create after seeing PR #12');
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: protectedPr }),
      /Refusing to use protected live release PR #12/,
    );
    assert.equal(remoteRef(f, injected.lineRef), injected.graph.v);
    assert.equal(remoteRef(f, injected.backupRef), injected.graph.h);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('all Git write helpers reject every ref outside the seven exact names before invoking Git', () => {
  let calls = 0;
  const git = {
    run() {
      calls += 1;
      throw new Error('must not run');
    },
  };
  for (const ref of [
    'refs/heads/releases/v1.0',
    'refs/heads/staged/v1.0',
    `${NAMESPACE}/other`,
    `${NAMESPACE}/../line`,
    'refs/tags/v1.0.1',
  ]) {
    assert.throws(() => assertConflictRef(ref), /outside the exact/);
    assert.throws(() => pushWithLease(git, ref, null, '1'.repeat(40)), /outside the exact/);
  }
  assert.throws(() => conflictRef('pr-12'), /Unsupported/);
  assert.equal(calls, 0);
});

test('intentional failure writes structured evidence and job summary before returning nonzero', async () => {
  const f = fixture();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'lab-01-conflict-evidence-'));
  try {
    const result = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git({ cwd: f.runner, remote: f.remote }),
      source: f.source,
    });
    const summaryPath = join(evidenceRoot, 'summary.md');
    const outputPath = join(evidenceRoot, 'output.txt');
    writeFileSync(summaryPath, '');
    writeFileSync(outputPath, '');
    let stdout = '';
    const exitCode = finalizeResult(result, {
      summaryPath,
      outputPath,
      writeStdout: (value) => {
        stdout += value;
      },
    });
    assert.equal(exitCode, INTENTIONAL_FAILURE_EXIT_CODE);
    assert.match(readFileSync(summaryPath, 'utf8'), /after-durable-force-before-pr/);
    assert.match(readFileSync(summaryPath, 'utf8'), new RegExp(result.remoteBackup));
    assert.match(readFileSync(outputPath, 'utf8'), /evidence<<CONFLICT_RECOVERY_EVIDENCE/);
    assert.match(readFileSync(outputPath, 'utf8'), /failure_point=after-durable-force-before-pr/);
    assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`backup_sha=${result.graph.h}`));
    assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`line_sha=${result.graph.v}`));
    assert.match(stdout, /intentional-failure-after-durable-force-before-pr/);
  } finally {
    f.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('workflow is manual, trusted-main-only, fixed-concurrency, and minimally permissioned', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/calibrate-conflict-recovery.yml', import.meta.url),
    'utf8',
  );
  const script = readFileSync(new URL('../scripts/calibrate-conflict-recovery.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /- inject-after-force\n\s+- resume/);
  assert.match(workflow, /permissions:\n  contents: write\n  pull-requests: write/);
  assert.match(workflow, /group: calibration-g1-conflict-recovery\n/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /persist-credentials: true/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /steps\.calibrate\.outputs\.failure_point/);
  assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /issues:|packages:|actions:|id-token:|secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /releases\/v1\.0|staged\/v1\.0/);
  assert.doesNotMatch(script, /releases\/v1\.0|staged\/v1\.0|\/pulls\/12|refs\/tags\//);
});
