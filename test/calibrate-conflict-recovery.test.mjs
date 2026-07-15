import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FILE_PATH,
  Git,
  GitHub,
  INTENTIONAL_FAILURE_EXIT_CODE,
  NAMESPACE,
  assertConflictRef,
  conflictRef,
  createGraph,
  finalizeResult,
  isExactStaleLeaseRejection,
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

function gitOptions(f) {
  return { cwd: f.runner, acceptedRemoteUrls: [f.remote] };
}

function parents(f, sha) {
  return command(f.runner, ['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

function tree(f, sha) {
  return command(f.runner, ['show', '-s', '--format=%T', sha]);
}

function commitWithMode(f, commit, parent, mode, message) {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-forged-mode-'));
  const index = join(root, 'index');
  const content = join(root, 'content.txt');
  try {
    writeFileSync(
      content,
      message.includes('V')
        ? 'release snapshot for 1.0.1\n'
        : 'complete late work for the recovery patch\n',
    );
    const blob = command(f.runner, ['hash-object', '-w', content]);
    const env = { GIT_INDEX_FILE: index };
    command(f.runner, ['read-tree', `${commit}^{tree}`], env);
    command(f.runner, ['update-index', '--cacheinfo', `${mode},${blob},${FILE_PATH}`], env);
    const forgedTree = command(f.runner, ['write-tree'], env);
    return command(f.runner, ['commit-tree', forgedTree, '-p', parent, '-m', message], {
      GIT_AUTHOR_NAME: 'Forged Mode Test',
      GIT_AUTHOR_EMAIL: 'forged@example.invalid',
      GIT_AUTHOR_DATE: '2026-07-15T16:00:00Z',
      GIT_COMMITTER_NAME: 'Forged Mode Test',
      GIT_COMMITTER_EMAIL: 'forged@example.invalid',
      GIT_COMMITTER_DATE: '2026-07-15T16:00:00Z',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function topLevelBlock(yaml, key) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `missing top-level ${key}`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(' ')) break;
    if (line.startsWith('  ')) block.push(line.slice(2));
    else if (line === '') block.push('');
  }
  while (block.at(-1) === '') block.pop();
  return block.join('\n');
}

function parseWorkflowYaml(yaml) {
  const ruby = [
    'document = Psych.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false)',
    'trigger = document.key?("on") ? document["on"] : document[true]',
    'puts JSON.generate({"on" => trigger, "permissions" => document["permissions"], "jobs" => document["jobs"]})',
  ].join('; ');
  return JSON.parse(
    execFileSync('ruby', ['-rpsych', '-rjson', '-e', ruby], { input: yaml, encoding: 'utf8' }),
  );
}

function assertExactWorkflowAuthority(workflow) {
  const parsed = parseWorkflowYaml(workflow);
  assert.deepEqual(parsed.on, {
    workflow_dispatch: {
      inputs: {
        mode: {
          description: 'Fixed conflict recovery phase to exercise',
          required: true,
          type: 'choice',
          options: ['inject-after-force', 'resume'],
        },
      },
    },
  });
  assert.deepEqual(parsed.permissions, { contents: 'write', 'pull-requests': 'write' });
  for (const [name, job] of Object.entries(parsed.jobs)) {
    assert.ok(!Object.hasOwn(job, 'permissions'), `job ${name} must not override permissions`);
  }
  assert.equal(
    topLevelBlock(workflow, 'on'),
    [
      'workflow_dispatch:',
      '  inputs:',
      '    mode:',
      '      description: Fixed conflict recovery phase to exercise',
      '      required: true',
      '      type: choice',
      '      options:',
      '        - inject-after-force',
      '        - resume',
    ].join('\n'),
  );
  assert.equal(
    topLevelBlock(workflow, 'permissions'),
    ['contents: write', 'pull-requests: write'].join('\n'),
  );
  assert.equal(workflow.match(/^on:$/gm)?.length, 1);
  assert.equal(workflow.match(/^permissions:$/gm)?.length, 1);
  assert.equal(workflow.match(/^[ \t]+(?:permissions|['"]permissions['"])[ \t]*:.*$/gm), null);
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

function assertSafePushInvocations(pushes) {
  const allowed = new Set(
    ['source', 'intent', 'm', 'v', 'h', 'backup', 'line', 'pr-attempt'].map(conflictRef),
  );
  assert.ok(pushes.length > 0);
  for (const args of pushes) {
    assert.equal(args[0], 'push');
    assert.ok(args.includes('--porcelain'));
    assert.ok(args.includes('--no-follow-tags'));
    assert.ok(!args.includes('--delete'));
    const remoteIndex = args.indexOf('origin');
    assert.ok(remoteIndex > 0, `push does not target origin: ${args.join(' ')}`);
    const refspecs = args.slice(remoteIndex + 1);
    assert.ok(refspecs.length === 1 || (args.includes('--atomic') && refspecs.length === 2));
    for (const refspec of refspecs) {
      const [source, destination, extra] = refspec.split(':');
      assert.match(source, /^[0-9a-f]{40}$/);
      assert.ok(allowed.has(destination), `unexpected destination ${destination}`);
      assert.equal(extra, undefined);
      assert.doesNotMatch(destination, /^refs\/tags\//);
    }
  }
}

function pullFor(graph, input, number = 101) {
  return {
    number,
    html_url: `https://github.com/fablebookjs/lab-01/pull/${number}`,
    state: 'open',
    draft: true,
    merged: false,
    merged_at: null,
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

  async listPullRequestHistoryPage(filter) {
    this.listCalls.push(filter);
    return filter.page === 1 ? structuredClone(this.pulls) : [];
  }

  async createPullRequest(input) {
    this.createCalls.push(input);
    const pull = pullFor(this.graph, input);
    this.pulls.push(pull);
    return structuredClone(pull);
  }

  async waitForRetry() {}
}

test('inject-after-force creates the exact conflicting graph, backs up H first, and never plans a PR', async () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const github = {
      async listPullRequestHistoryPage() {
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
    assertSafePushInvocations(git.pushes);

    const refs = command(f.runner, ['ls-remote', '--heads', f.remote])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1]);
    const calibrationRefs = refs.filter((ref) => ref.startsWith('refs/heads/calibration/'));
    assert.deepEqual(
      calibrationRefs.sort(),
      ['source', 'intent', 'm', 'v', 'h', 'backup', 'line', 'pr-attempt'].map(conflictRef).sort(),
    );
    assert.equal(remoteRef(f, conflictRef('pr-attempt')), first.graph.h);

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

    const interruptedGit = new FailBackupOnceGit(gitOptions(f));
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git: interruptedGit, source: f.source }),
      /simulated backup transport failure/,
    );
    const expected = createGraph(interruptedGit, f.source);
    assert.equal(remoteRef(f, conflictRef('line')), expected.h);
    assert.equal(remoteRef(f, conflictRef('backup')), null);

    const resumed = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git(gitOptions(f)),
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

test('trusted-main source drift fails before any ref push or PR API call', async () => {
  const f = fixture();
  try {
    await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git(gitOptions(f)),
      source: f.source,
    });
    writeFileSync(join(f.root, 'seed', 'second.txt'), 'trusted main advanced\n');
    command(join(f.root, 'seed'), ['add', 'second.txt']);
    command(join(f.root, 'seed'), ['commit', '-m', 'advance trusted main'], {
      GIT_AUTHOR_DATE: '2026-07-15T11:30:00Z',
      GIT_COMMITTER_DATE: '2026-07-15T11:30:00Z',
    });
    const source2 = command(join(f.root, 'seed'), ['rev-parse', 'HEAD']);
    command(join(f.root, 'seed'), ['push', 'origin', 'main']);
    assert.notEqual(source2, f.source);

    const git = new RecordingGit(gitOptions(f));
    const github = new FakeGitHub({});
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
      /Remote refs\/heads\/main .* is not trusted source/,
    );
    assert.equal(git.pushes.length, 0);
    assert.equal(github.listCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.equal(remoteRef(f, conflictRef('source')), f.source);
  } finally {
    f.cleanup();
  }
});

test('a first inject from stale dispatched A fails after remote main advances B with zero writes', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seed', 'advanced-before-dispatch.txt'), 'remote B\n');
    command(join(f.root, 'seed'), ['add', 'advanced-before-dispatch.txt']);
    command(join(f.root, 'seed'), ['commit', '-m', 'advance before stale dispatch'], {
      GIT_AUTHOR_DATE: '2026-07-15T11:40:00Z',
      GIT_COMMITTER_DATE: '2026-07-15T11:40:00Z',
    });
    command(join(f.root, 'seed'), ['push', 'origin', 'main']);

    const git = new RecordingGit(gitOptions(f));
    const github = new FakeGitHub({});
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git, source: f.source, github }),
      /Remote refs\/heads\/main .* is not trusted source/,
    );
    assert.equal(git.pushes.length, 0);
    assert.equal(github.listCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.equal(remoteRef(f, conflictRef('source')), null);
  } finally {
    f.cleanup();
  }
});

test('remote main drift after marker creation fails before the first PR API call', async () => {
  const f = fixture();
  try {
    const injected = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git(gitOptions(f)),
      source: f.source,
    });
    writeFileSync(join(f.root, 'seed', 'drift.txt'), 'remote main drift\n');
    command(join(f.root, 'seed'), ['add', 'drift.txt']);
    command(join(f.root, 'seed'), ['commit', '-m', 'prepare remote drift'], {
      GIT_AUTHOR_DATE: '2026-07-15T11:45:00Z',
      GIT_COMMITTER_DATE: '2026-07-15T11:45:00Z',
    });

    class DriftBeforeApiGit extends Git {
      drifted = false;

      assertTrustedSource() {
        if (!this.drifted && remoteRef(f, conflictRef('pr-attempt')) === injected.graph.h) {
          this.drifted = true;
          command(join(f.root, 'seed'), ['push', 'origin', 'main']);
        }
        return super.assertTrustedSource();
      }
    }

    const git = new DriftBeforeApiGit(gitOptions(f));
    const github = new FakeGitHub(injected.graph);
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
      /Remote refs\/heads\/main .* is not trusted source/,
    );
    assert.equal(remoteRef(f, conflictRef('pr-attempt')), injected.graph.h);
    assert.equal(github.listCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('merge-tree proof accepts only status 1 and one exact fixed-path conflict record', () => {
  const f = fixture();
  try {
    const baseGit = new Git(gitOptions(f));
    const graph = createGraph(baseGit, f.source);
    const exact = `CONFLICT (add/add): Merge conflict in ${FILE_PATH}`;
    const impostors = [
      { status: 128, stdout: `${exact}\n`, stderr: 'fatal: parser failed' },
      { status: 0, stdout: `${exact}\n`, stderr: '' },
      { status: 1, stdout: 'CONFLICT (content): Merge conflict in another.txt\n', stderr: '' },
      { status: 1, stdout: `${exact}\nCONFLICT (add/add): Merge conflict in another.txt\n`, stderr: '' },
      { status: 1, stdout: `prefix ${exact}\n`, stderr: '' },
    ];
    for (const forged of impostors) {
      class ForgedMergeTreeGit extends Git {
        run(args, options) {
          if (args[0] === 'merge-tree') return forged;
          return super.run(args, options);
        }
      }
      assert.throws(
        () => verifyGraph(new ForgedMergeTreeGit(gitOptions(f)), graph),
        /required genuine conflict/,
      );
    }
    assert.equal(verifyGraph(baseGit, graph).mergeTreeExit, 1);
  } finally {
    f.cleanup();
  }
});

test('V and H reject forged executable entries even when content and parents match', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const graph = createGraph(git, f.source);
    for (const role of ['v', 'h']) {
      const forged = commitWithMode(
        f,
        graph[role],
        graph.m,
        '100755',
        `forged executable ${role.toUpperCase()}`,
      );
      assert.throws(
        () => verifyGraph(git, { ...graph, [role]: forged }),
        new RegExp(`${role.toUpperCase()} fixed conflict entry is not canonical 100644 blob`),
      );
    }
  } finally {
    f.cleanup();
  }
});

test('resume forces an H line only after verifying the backup, creates one draft PR, then reuses it', async () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const injected = await runConflictRecovery({
      mode: 'inject-after-force',
      git: setupGit,
      source: f.source,
    });
    command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);

    const git = new RecordingGit(gitOptions(f));
    const github = new FakeGitHub(injected.graph);
    const first = await runConflictRecovery({ mode: 'resume', git, source: f.source, github });
    assert.equal(first.forceResult, 'forced-h-to-v');
    assert.equal(first.outcome, 'recovery-pr-created');
    assert.equal(first.pullRequest.number, 101);
    assert.equal(first.pullRequest.draft, true);
    assert.equal(remoteRef(f, first.lineRef), first.graph.v);
    assert.equal(remoteRef(f, first.backupRef), first.graph.h);
    assert.equal(remoteRef(f, conflictRef('pr-attempt')), first.graph.v);
    const retainedCalibrationRefs = command(f.runner, ['ls-remote', '--heads', f.remote])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1])
      .filter((ref) => ref.startsWith(`${NAMESPACE}/`));
    assert.deepEqual(
      retainedCalibrationRefs.sort(),
      ['source', 'intent', 'm', 'v', 'h', 'backup', 'line', 'pr-attempt'].map(conflictRef).sort(),
    );
    assert.equal(github.createCalls.length, 1);
    assert.ok(
      git.pushes.some(
        (args) =>
          args.includes(`--force-with-lease=${conflictRef('pr-attempt')}:${first.graph.h}`) &&
          args.at(-1) === `${first.graph.v}:${conflictRef('pr-attempt')}`,
      ),
    );
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
    assertSafePushInvocations(git.pushes);

    const pushesBeforeRerun = git.pushes.length;
    github.pulls[0].title = 'Human-edited recovery title';
    github.pulls[0].body = 'Human notes retained after creation';
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
    const git = new Git(gitOptions(f));
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
    const setupGit = new Git(gitOptions(f));
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
        git: new RacingGit(gitOptions(f)),
        source: f.source,
        github,
      }),
      /Stale atomic lease rejected recovery force/,
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

test('atomic backup and line leases reject backup rewrite or deletion without moving line H', async () => {
  for (const mutation of ['rewrite', 'delete']) {
    const f = fixture();
    try {
      const setupGit = new Git(gitOptions(f));
      const injected = await runConflictRecovery({ mode: 'inject-after-force', git: setupGit, source: f.source });
      command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);

      class BackupRaceGit extends Git {
        raced = false;

        run(args, options) {
          if (!this.raced && args[0] === 'push' && args.includes('--atomic')) {
            this.raced = true;
            const refspec =
              mutation === 'delete'
                ? `:${injected.backupRef}`
                : `${injected.graph.m}:${injected.backupRef}`;
            command(f.runner, ['push', '--force', f.remote, refspec]);
          }
          return super.run(args, options);
        }
      }

      const github = new FakeGitHub(injected.graph);
      await assert.rejects(
        runConflictRecovery({
          mode: 'resume',
          git: new BackupRaceGit(gitOptions(f)),
          source: f.source,
          github,
        }),
        /Stale atomic lease rejected recovery force/,
      );
      assert.equal(remoteRef(f, injected.lineRef), injected.graph.h, mutation);
      assert.equal(
        remoteRef(f, injected.backupRef),
        mutation === 'delete' ? null : injected.graph.m,
        mutation,
      );
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('post-force backup drift fails before PR creation even though line reached V', async () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git: setupGit, source: f.source });
    command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);

    class PostForceDriftGit extends Git {
      drifted = false;

      run(args, options) {
        const result = super.run(args, options);
        if (!this.drifted && args[0] === 'push' && args.includes('--atomic') && result.status === 0) {
          this.drifted = true;
          command(f.runner, ['push', '--force', f.remote, `:${injected.backupRef}`]);
        }
        return result;
      }
    }

    const github = new FakeGitHub(injected.graph);
    await assert.rejects(
      runConflictRecovery({
        mode: 'resume',
        git: new PostForceDriftGit(gitOptions(f)),
        source: f.source,
        github,
      }),
      /Remote recovery backup is absent, expected/,
    );
    assert.equal(remoteRef(f, injected.lineRef), injected.graph.v);
    assert.equal(remoteRef(f, injected.backupRef), null);
    assert.equal(github.createCalls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('inject retains truthful structured evidence when backup drifts after line reaches V', async () => {
  for (const mutation of ['delete', 'rewrite']) {
    const f = fixture();
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'lab-01-abnormal-injection-evidence-'));
    try {
      class PostAtomicInjectionDriftGit extends Git {
        drifted = false;

        run(args, options) {
          const result = super.run(args, options);
          if (!this.drifted && args[0] === 'push' && args.includes('--atomic') && result.status === 0) {
            this.drifted = true;
            const backupRef = conflictRef('backup');
            const refspec = mutation === 'delete' ? `:${backupRef}` : `${this.trustedSource}:${backupRef}`;
            command(f.runner, ['push', '--force', f.remote, refspec]);
          }
          return result;
        }
      }

      const github = {
        async listPullRequestHistoryPage() {
          throw new Error('inject safety evidence must precede every PR API');
        },
        async createPullRequest() {
          throw new Error('inject safety evidence must never create a PR');
        },
      };
      const result = await runConflictRecovery({
        mode: 'inject-after-force',
        git: new PostAtomicInjectionDriftGit(gitOptions(f)),
        source: f.source,
        github,
      });
      assert.equal(result.outcome, 'safety-failure-after-durable-force-before-pr');
      assert.equal(result.intentionalFailure, true);
      assert.equal(result.failurePoint, 'after-durable-force-before-pr');
      assert.equal(result.finalLine, result.graph.v);
      assert.equal(result.backupVerified, false);
      assert.equal(
        result.remoteBackup,
        mutation === 'delete' ? null : f.source,
      );

      const summaryPath = join(evidenceRoot, 'summary.md');
      const outputPath = join(evidenceRoot, 'output.txt');
      writeFileSync(summaryPath, '');
      writeFileSync(outputPath, '');
      assert.equal(finalizeResult(result, { summaryPath, outputPath, writeStdout() {} }), 78);
      assert.match(readFileSync(summaryPath, 'utf8'), /safety-failure-after-durable-force-before-pr/);
      assert.match(readFileSync(summaryPath, 'utf8'), /Backup verified as exact complete H: `false`/);
      assert.match(readFileSync(outputPath, 'utf8'), /backup_verified=false/);
      assert.match(readFileSync(outputPath, 'utf8'), /failure_point=after-durable-force-before-pr/);
      assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`line_sha=${result.graph.v}`));

      const resumeGithub = new FakeGitHub(result.graph);
      await assert.rejects(
        runConflictRecovery({
          mode: 'resume',
          git: new Git(gitOptions(f)),
          source: f.source,
          github: resumeGithub,
        }),
        /Fixed recovery backup .* expected complete H/,
      );
      assert.equal(resumeGithub.listCalls.length, 0);
      assert.equal(resumeGithub.createCalls.length, 0);
    } finally {
      f.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }
});

test('rerun inject retains safety evidence when a completed V state later loses its backup', async () => {
  for (const mutation of ['delete', 'rewrite']) {
    const f = fixture();
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'lab-01-restart-injection-evidence-'));
    try {
      const git = new Git(gitOptions(f));
      const complete = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
      const refspec =
        mutation === 'delete'
          ? `:${complete.backupRef}`
          : `${complete.graph.m}:${complete.backupRef}`;
      command(f.runner, ['push', '--force', f.remote, refspec]);

      const result = await runConflictRecovery({
        mode: 'inject-after-force',
        git: new Git(gitOptions(f)),
        source: f.source,
        github: {
          async listPullRequestHistoryPage() {
            throw new Error('restart injection must not query PR history');
          },
          async createPullRequest() {
            throw new Error('restart injection must not create a PR');
          },
        },
      });
      assert.equal(result.outcome, 'safety-failure-after-durable-force-before-pr');
      assert.equal(result.finalLine, result.graph.v);
      assert.equal(result.remoteBackup, mutation === 'delete' ? null : result.graph.m);
      assert.equal(result.backupVerified, false);
      assert.equal(remoteRef(f, conflictRef('pr-attempt')), result.graph.h);

      const summaryPath = join(evidenceRoot, 'summary.md');
      const outputPath = join(evidenceRoot, 'output.txt');
      writeFileSync(summaryPath, '');
      writeFileSync(outputPath, '');
      assert.equal(finalizeResult(result, { summaryPath, outputPath, writeStdout() {} }), 78);
      assert.match(readFileSync(summaryPath, 'utf8'), /safety-failure-after-durable-force-before-pr/);
      assert.match(readFileSync(outputPath, 'utf8'), /backup_verified=false/);
      assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`expected_backup_sha=${result.graph.h}`));
      assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`line_sha=${result.graph.v}`));
    } finally {
      f.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }
});

test('lost success of the atomic force converges to retained evidence and resume creates one PR', async () => {
  const f = fixture();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'lab-01-lost-force-evidence-'));
  try {
    class LostSuccessGit extends RecordingGit {
      lost = false;

      run(args, options) {
        const result = super.run(args, options);
        if (!this.lost && args[0] === 'push' && args.includes('--atomic') && result.status === 0) {
          this.lost = true;
          return { status: 1, stdout: '', stderr: 'simulated disconnect after receive' };
        }
        return result;
      }
    }

    const git = new LostSuccessGit(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    assert.equal(injected.forceResult, 'forced-h-to-v-lost-success');
    assert.equal(injected.failurePoint, 'after-durable-force-before-pr');
    assert.equal(remoteRef(f, injected.backupRef), injected.graph.h);
    assert.equal(remoteRef(f, injected.lineRef), injected.graph.v);
    assertSafePushInvocations(git.pushes);

    const summaryPath = join(evidenceRoot, 'summary.md');
    const outputPath = join(evidenceRoot, 'output.txt');
    writeFileSync(summaryPath, '');
    writeFileSync(outputPath, '');
    assert.equal(finalizeResult(injected, { summaryPath, outputPath, writeStdout() {} }), 78);
    assert.match(readFileSync(outputPath, 'utf8'), /failure_point=after-durable-force-before-pr/);
    assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`backup_sha=${injected.graph.h}`));
    assert.match(readFileSync(outputPath, 'utf8'), new RegExp(`line_sha=${injected.graph.v}`));

    const github = new FakeGitHub(injected.graph);
    const resumed = await runConflictRecovery({ mode: 'resume', git: new Git(gitOptions(f)), source: f.source, github });
    assert.equal(resumed.outcome, 'recovery-pr-created');
    const rerun = await runConflictRecovery({ mode: 'resume', git: new Git(gitOptions(f)), source: f.source, github });
    assert.equal(rerun.outcome, 'recovery-pr-reused');
    assert.equal(github.createCalls.length, 1);
  } finally {
    f.cleanup();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('closed, duplicate, protected, aliased, and immutable-field PR history fails closed', async () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    const input = {
      title: 'Recover conflict calibration work after 1.0.1',
      body: recoveryPullRequestBody(injected.graph),
      base: 'calibration/g1/conflict-recovery/line',
      head: 'calibration/g1/conflict-recovery/backup',
      draft: true,
    };

    const open = pullFor(injected.graph, input, 101);
    const closed = { ...pullFor(injected.graph, input, 100), state: 'closed' };
    let createCalls = 0;
    const history = (pulls) => ({
      async listPullRequestHistoryPage({ page }) {
        return page === 1 ? structuredClone(pulls) : [];
      },
      async createPullRequest() {
        createCalls += 1;
        throw new Error('must not create from existing history');
      },
    });

    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([open, closed]) }),
      /More than one historical recovery PR/,
    );
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([closed]) }),
      /Recovery PR is not one open draft/,
    );

    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([pullFor(injected.graph, input, 12)]) }),
      /Invalid or protected recovery PR number: 12/,
    );

    const stringTwelve = { ...pullFor(injected.graph, input, 101), number: '12' };
    const urlAlias = { ...pullFor(injected.graph, input, 101), html_url: 'https://github.com/fablebookjs/lab-01/pull/12' };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([stringTwelve]) }),
      /Invalid or protected recovery PR number/,
    );
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([urlAlias]) }),
      /URL is not canonical/,
    );

    const immutableDrift = [
      { field: 'base ref', pull: { ...open, base: { ...open.base, ref: 'main' } }, error: /base is not the exact/ },
      { field: 'base SHA', pull: { ...open, base: { ...open.base, sha: injected.graph.m } }, error: /base is not the exact/ },
      { field: 'base repo', pull: { ...open, base: { ...open.base, repo: { full_name: 'other/repo' } } }, error: /base is not the exact/ },
      { field: 'head ref', pull: { ...open, head: { ...open.head, ref: 'other' } }, error: /head is not the same/ },
      { field: 'head SHA', pull: { ...open, head: { ...open.head, sha: injected.graph.m } }, error: /head is not the same/ },
      { field: 'head repo', pull: { ...open, head: { ...open.head, repo: { full_name: 'other/repo' } } }, error: /head is not the same/ },
      { field: 'draft', pull: { ...open, draft: false }, error: /not one open draft/ },
      { field: 'state', pull: { ...open, state: 'closed' }, error: /not one open draft/ },
      { field: 'merged boolean', pull: { ...open, merged: true }, error: /contradictory merged state/ },
      {
        field: 'merged timestamp',
        pull: { ...open, merged_at: '2026-07-15T15:00:00Z' },
        error: /contradictory merged state/,
      },
    ];
    for (const drift of immutableDrift) {
      await assert.rejects(
        runConflictRecovery({ mode: 'resume', git, source: f.source, github: history([drift.pull]) }),
        drift.error,
        drift.field,
      );
    }
    assert.equal(createCalls, 0);
    assert.equal(remoteRef(f, injected.lineRef), injected.graph.v);
    assert.equal(remoteRef(f, injected.backupRef), injected.graph.h);
    assert.equal(remoteRef(f, 'refs/heads/releases/v1.0'), f.source);
    assert.equal(remoteRef(f, 'refs/heads/staged/v1.0'), f.source);
  } finally {
    f.cleanup();
  }
});

test('wrong or disappearing PR-attempt markers fail closed without a second POST', async () => {
  {
    const f = fixture();
    try {
      const git = new Git(gitOptions(f));
      const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
      command(f.runner, ['push', '--force', f.remote, `${injected.graph.m}:${conflictRef('pr-attempt')}`]);
      const github = new FakeGitHub(injected.graph);
      await assert.rejects(
        runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
        /PR-attempt marker .* expected exact H or V/,
      );
      assert.equal(github.listCalls.length, 0);
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const git = new Git(gitOptions(f));
      const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
      const github = {
        listCalls: 0,
        createCalls: 0,
        async listPullRequestHistoryPage() {
          this.listCalls += 1;
          return [];
        },
        async createPullRequest(input) {
          this.createCalls += 1;
          command(f.runner, ['push', '--force', f.remote, `:${conflictRef('pr-attempt')}`]);
          return pullFor(injected.graph, input);
        },
        async waitForRetry() {},
      };
      await assert.rejects(
        runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
        /PR-attempt marker .* absent, expected exact V/,
      );
      assert.equal(github.createCalls, 1);
      assert.equal(remoteRef(f, conflictRef('pr-attempt')), null);
      assert.equal(remoteRef(f, injected.lineRef), injected.graph.v);
      await assert.rejects(
        runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
        /PR-attempt marker .* absent, expected exact H or V/,
      );
      assert.equal(github.createCalls, 1);
    } finally {
      f.cleanup();
    }
  }

  {
    const f = fixture();
    try {
      const git = new Git(gitOptions(f));
      const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
      command(f.runner, ['push', '--force', f.remote, `${injected.graph.v}:${conflictRef('pr-attempt')}`]);
      const github = new FakeGitHub(injected.graph);
      await assert.rejects(
        runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
        /marker is V but no matching PR is visible; refusing another POST/,
      );
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('all-state history pagination reaches page 2 and rejects later closed duplicates without POST', async () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    const input = {
      title: 'Recover conflict calibration work after 1.0.1',
      body: recoveryPullRequestBody(injected.graph),
      base: 'calibration/g1/conflict-recovery/line',
      head: 'calibration/g1/conflict-recovery/backup',
      draft: true,
    };
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      pullFor(injected.graph, input, 1000 + index),
    );
    const laterClosed = { ...pullFor(injected.graph, input, 2000), state: 'closed' };
    const github = {
      calls: [],
      createCalls: 0,
      async listPullRequestHistoryPage(query) {
        this.calls.push(query);
        if (query.page === 1) return structuredClone(firstPage);
        if (query.page === 2) return [structuredClone(laterClosed)];
        return [];
      },
      async createPullRequest() {
        this.createCalls += 1;
        throw new Error('pagination history must prevent POST');
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
      /More than one historical recovery PR/,
    );
    assert.deepEqual(
      github.calls.map((call) => call.page),
      [1, 2],
    );
    assert.ok(
      github.calls.every(
        (call) =>
          call.base === 'calibration/g1/conflict-recovery/line' &&
          call.head === 'fablebookjs:calibration/g1/conflict-recovery/backup',
      ),
    );
    assert.equal(github.createCalls, 0);

    const endless = {
      pages: [],
      createCalls: 0,
      async listPullRequestHistoryPage(query) {
        this.pages.push(query.page);
        return structuredClone(firstPage);
      },
      async createPullRequest() {
        this.createCalls += 1;
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: endless }),
      /history exceeded the fixed 10-page limit/,
    );
    assert.deepEqual(endless.pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(endless.createCalls, 0);
  } finally {
    f.cleanup();
  }
});

test('post-create history retries are bounded, delayed visibility converges, and permanent absence fails', async () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    const delayed = {
      historyCalls: 0,
      waits: [],
      pull: null,
      async listPullRequestHistoryPage() {
        this.historyCalls += 1;
        return this.pull && this.historyCalls >= 4 ? [structuredClone(this.pull)] : [];
      },
      async createPullRequest(input) {
        this.pull = pullFor(injected.graph, input);
        return structuredClone(this.pull);
      },
      async waitForRetry(milliseconds) {
        this.waits.push(milliseconds);
      },
    };
    const converged = await runConflictRecovery({ mode: 'resume', git, source: f.source, github: delayed });
    assert.equal(converged.outcome, 'recovery-pr-created');
    assert.equal(delayed.historyCalls, 4);
    assert.deepEqual(delayed.waits, [100, 200]);

    command(f.runner, [
      'push',
      '--force',
      f.remote,
      `${injected.graph.h}:${conflictRef('pr-attempt')}`,
    ]);

    const absent = {
      historyCalls: 0,
      waits: [],
      async listPullRequestHistoryPage() {
        this.historyCalls += 1;
        return [];
      },
      async createPullRequest(input) {
        return pullFor(injected.graph, input, 102);
      },
      async waitForRetry(milliseconds) {
        this.waits.push(milliseconds);
      },
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github: absent }),
      /did not converge to exactly one all-state historical PR/,
    );
    assert.equal(absent.historyCalls, 5);
    assert.deepEqual(absent.waits, [100, 200, 300]);
  } finally {
    f.cleanup();
  }
});

test('ambiguous PR creation never POSTs twice while visibility remains stale, then reuses later', async () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git, source: f.source });
    const github = {
      pulls: [],
      createCalls: 0,
      visible: false,
      async listPullRequestHistoryPage() {
        return this.visible ? structuredClone(this.pulls) : [];
      },
      async createPullRequest(input) {
        this.createCalls += 1;
        this.pulls = [pullFor(injected.graph, input)];
        throw new Error('connection lost after GitHub created the PR');
      },
      async waitForRetry() {},
    };
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
      /POST was ambiguous and no canonical PR became visible/,
    );
    await assert.rejects(
      runConflictRecovery({ mode: 'resume', git, source: f.source, github }),
      /marker is V but no matching PR is visible/,
    );
    assert.equal(github.createCalls, 1);
    github.visible = true;
    const rerun = await runConflictRecovery({ mode: 'resume', git, source: f.source, github });
    assert.equal(rerun.outcome, 'recovery-pr-reused');
    assert.equal(rerun.pullRequest.number, 101);
    assert.equal(github.createCalls, 1);

    const requestProbe = Object.create(GitHub.prototype);
    requestProbe.request = async (path) => path;
    const path = await requestProbe.listPullRequestHistoryPage({ base: 'base', head: 'owner:head', page: 2 });
    assert.match(path, /state=all/);
    assert.doesNotMatch(path, /state=open/);
    assert.match(path, /base=base/);
    assert.match(path, /head=owner%3Ahead/);
    assert.match(path, /page=2/);
  } finally {
    f.cleanup();
  }
});

test('all Git write helpers reject every ref outside the eight exact names before invoking Git', () => {
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

test('only exact porcelain stale-info output counts as stale lease evidence', async () => {
  const ref = conflictRef('line');
  const candidate = '1'.repeat(40);
  const exact = `!\t${candidate}:${ref}\t[rejected] (stale info)\n`;
  assert.equal(isExactStaleLeaseRejection({ status: 1, stdout: exact, stderr: '' }, ref, candidate), true);
  for (const impostor of [
    { status: 1, stdout: '', stderr: 'authentication failed' },
    { status: 1, stdout: '', stderr: 'transport disconnected' },
    { status: 1, stdout: `!\t${candidate}:${ref}\t[remote rejected] (policy)\n`, stderr: '' },
    { status: 0, stdout: exact, stderr: '' },
    { status: 1, stdout: `!\t${'2'.repeat(40)}:${ref}\t[rejected] (stale info)\n`, stderr: '' },
  ]) {
    assert.equal(isExactStaleLeaseRejection(impostor, ref, candidate), false);
  }

  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const injected = await runConflictRecovery({ mode: 'inject-after-force', git: setupGit, source: f.source });
    command(f.runner, ['push', '--force', f.remote, `${injected.graph.h}:${injected.lineRef}`]);
    for (const failure of [
      { status: 1, stdout: '', stderr: 'authentication failed' },
      { status: 1, stdout: '', stderr: 'transport disconnected' },
      {
        status: 1,
        stdout: `!\t${injected.graph.v}:${injected.lineRef}\t[remote rejected] (policy)\n`,
        stderr: '',
      },
    ]) {
      class FailedAtomicPushGit extends Git {
        run(args, options) {
          if (args[0] === 'push' && args.includes('--atomic')) return failure;
          return super.run(args, options);
        }
      }
      await assert.rejects(
        runConflictRecovery({
          mode: 'resume',
          git: new FailedAtomicPushGit(gitOptions(f)),
          source: f.source,
          github: new FakeGitHub(injected.graph),
        }),
        /failed without stale-lease proof/,
      );
      assert.equal(remoteRef(f, injected.lineRef), injected.graph.h);
    }
  } finally {
    f.cleanup();
  }
});

test('hostile Git environment, pushurl, and URL rewrites fail before push while auth config is preserved', async () => {
  const f = fixture();
  const outside = join(f.root, 'outside.git');
  try {
    command(f.root, ['init', '--bare', outside]);
    const hostileKeys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR'];
    const previous = Object.fromEntries(hostileKeys.map((key) => [key, process.env[key]]));
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'remote.origin.pushurl';
    process.env.GIT_CONFIG_VALUE_0 = outside;
    process.env.GIT_DIR = outside;
    try {
      const git = new RecordingGit(gitOptions(f));
      assert.equal(git.text(['rev-parse', '--git-dir']), '.git');
      await assert.rejects(
        runConflictRecovery({ mode: 'inject-after-force', git, source: f.source }),
        /Hostile inherited Git environment/,
      );
      assert.equal(git.pushes.length, 0);
    } finally {
      for (const key of hostileKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
    assert.equal(command(f.runner, ['ls-remote', outside]), '');

    command(f.runner, ['config', '--add', 'remote.origin.pushurl', outside]);
    const pushUrlGit = new RecordingGit(gitOptions(f));
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git: pushUrlGit, source: f.source }),
      /Explicit remote\.origin\.pushurl is forbidden/,
    );
    assert.equal(pushUrlGit.pushes.length, 0);
    command(f.runner, ['config', '--unset-all', 'remote.origin.pushurl']);

    const rewriteKey = `url.${outside}.pushInsteadOf`;
    command(f.runner, ['config', '--add', rewriteKey, f.remote]);
    const rewriteGit = new RecordingGit(gitOptions(f));
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git: rewriteGit, source: f.source }),
      /Configured Git URL rewrites are forbidden/,
    );
    assert.equal(rewriteGit.pushes.length, 0);
    command(f.runner, ['config', '--unset-all', rewriteKey]);

    command(f.runner, ['config', '--add', 'remote.origin.url', f.remote]);
    const multipleUrlGit = new RecordingGit(gitOptions(f));
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git: multipleUrlGit, source: f.source }),
      /Untrusted effective origin fetch URL\(s\)/,
    );
    assert.equal(multipleUrlGit.pushes.length, 0);
    command(f.runner, ['config', '--unset-all', 'remote.origin.url']);
    command(f.runner, ['config', 'remote.origin.url', f.remote]);

    command(f.runner, ['config', 'user.name', 'Test']);
    command(f.runner, ['config', 'user.email', 'test@example.invalid']);
    command(f.runner, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic retained']);
    command(f.runner, ['config', 'push.followTags', 'true']);
    command(f.runner, ['tag', '-a', 'hostile-follow-tag', f.source, '-m', 'must not follow']);
    const safeGit = new RecordingGit(gitOptions(f));
    await runConflictRecovery({ mode: 'inject-after-force', git: safeGit, source: f.source });
    assertSafePushInvocations(safeGit.pushes);
    assert.equal(command(f.runner, ['ls-remote', '--tags', f.remote]), '');
    assert.equal(
      command(f.runner, ['config', '--get', 'http.https://github.com/.extraheader']),
      'AUTHORIZATION: basic retained',
    );
  } finally {
    f.cleanup();
  }
});

test('attacker-controlled GIT_EXEC_PATH fails before any Git subprocess or destination write', async () => {
  const f = fixture();
  const previous = process.env.GIT_EXEC_PATH;
  let git;
  try {
    class CountingGit extends Git {
      calls = 0;

      run(args, options) {
        this.calls += 1;
        return super.run(args, options);
      }
    }

    process.env.GIT_EXEC_PATH = join(f.root, 'attacker-controlled-git-helpers');
    git = new CountingGit(gitOptions(f));
    await assert.rejects(
      runConflictRecovery({ mode: 'inject-after-force', git, source: f.source }),
      /Hostile inherited Git environment: GIT_EXEC_PATH/,
    );
    assert.equal(git.calls, 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = previous;
  }
  try {
    assert.equal(git.calls, 0);
    assert.equal(remoteRef(f, conflictRef('source')), null);
  } finally {
    f.cleanup();
  }
});

test('TLS, proxy, CA, and askpass overrides fail before Git while scoped checkout auth remains valid', async () => {
  const f = fixture();
  try {
    for (const [key, value] of [
      ['GIT_SSL_NO_VERIFY', '1'],
      ['HTTPS_PROXY', 'http://attacker.invalid:8080'],
      ['SSL_CERT_FILE', join(f.root, 'attacker-ca.pem')],
      ['GIT_ASKPASS', join(f.root, 'attacker-askpass')],
      ['GIT_PROXY_COMMAND', join(f.root, 'attacker-proxy')],
    ]) {
      const previous = process.env[key];
      class CountingGit extends Git {
        calls = 0;

        run(args, options) {
          this.calls += 1;
          return super.run(args, options);
        }
      }
      process.env[key] = value;
      const git = new CountingGit(gitOptions(f));
      try {
        await assert.rejects(
          runConflictRecovery({ mode: 'inject-after-force', git, source: f.source }),
          new RegExp(`Hostile inherited Git environment: ${key}`),
        );
        assert.equal(git.calls, 0, key);
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
    assert.equal(remoteRef(f, conflictRef('source')), null);

    command(f.runner, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic retained']);
    const result = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git(gitOptions(f)),
      source: f.source,
    });
    assert.equal(result.backupVerified, true);
    assert.equal(
      command(f.runner, ['config', '--get', 'http.https://github.com/.extraheader']),
      'AUTHORIZATION: basic retained',
    );
  } finally {
    f.cleanup();
  }
});

test('intentional failure writes structured evidence and job summary before returning nonzero', async () => {
  const f = fixture();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'lab-01-conflict-evidence-'));
  try {
    const result = await runConflictRecovery({
      mode: 'inject-after-force',
      git: new Git(gitOptions(f)),
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
  assertExactWorkflowAuthority(workflow);
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('workflow_dispatch:', 'workflow_dispatch:\n  pull_request:')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('  pull-requests: write', '  pull-requests: write\n  statuses: write')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('  timeout-minutes: 10', '  timeout-minutes: 10\n    permissions:\n      contents: write')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('  timeout-minutes: 10', '  timeout-minutes: 10\n    permissions: read-all')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('  timeout-minutes: 10', '  timeout-minutes: 10\n    permissions: { statuses: write }')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(workflow.replace('  timeout-minutes: 10', '  timeout-minutes: 10\n    "permissions": read-all')),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(
      workflow.replace(
        '        - resume\n\npermissions:',
        '        - resume\n  schedule:\n    - cron: "0 0 * * *"\n\npermissions:',
      ),
    ),
  );
  assert.throws(() =>
    assertExactWorkflowAuthority(
      workflow.replace(
        'jobs:\n',
        'jobs:\n  injected: { runs-on: ubuntu-latest, permissions: { statuses: write }, steps: [] }\n',
      ),
    ),
  );
  assert.match(workflow, /group: calibration-g1-conflict-recovery\n/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /persist-credentials: true/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /steps\.calibrate\.outputs\.failure_point/);
  assert.match(workflow, /steps\.calibrate\.outputs\.expected_backup_sha/);
  assert.match(workflow, /steps\.calibrate\.outputs\.backup_verified/);
  assert.match(workflow, /test "\$BACKUP_SHA" = "\$EXPECTED_BACKUP_SHA"/);
  assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /issues:|packages:|actions:|id-token:|secrets\.GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /releases\/v1\.0|staged\/v1\.0/);
  assert.doesNotMatch(script, /releases\/v1\.0|staged\/v1\.0|\/pulls\/12|refs\/tags\//);
  assert.doesNotMatch(script, /\bnpm\b|storybook/i);
  assert.match(script, /https:\/\/api\.github\.com\/repos\/\$\{REPOSITORY\}\$\{path\}/);
  const requestTargets = [...script.matchAll(/this\.request\((`[^`]+`|'[^']+')/g)].map((match) => match[1]);
  assert.deepEqual(requestTargets, ['`/pulls?${query}`', "'/pulls'"]);
});
