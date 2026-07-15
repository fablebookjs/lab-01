import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FILE_PATH,
  Git,
  NAMESPACE,
  ROLES,
  assertCalibrationRef,
  calibrationRef,
  createGraph,
  parseRemoteAdvertisement,
  pushWithLease,
  runStateCalibration,
  verifyGraph,
} from '../scripts/calibrate-required-check-state.mjs';
import { evaluateRequiredHead } from '../scripts/check-required-calibration-head.mjs';

function command(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', ...env },
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-required-check-test-'));
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
    GIT_AUTHOR_DATE: '2026-07-15T15:00:00Z',
    GIT_COMMITTER_DATE: '2026-07-15T15:00:00Z',
  });
  const source = command(seed, ['rev-parse', 'HEAD']);
  command(seed, ['remote', 'add', 'origin', remote]);
  command(seed, [
    'push',
    'origin',
    'main',
    `${source}:refs/heads/releases/v1.0`,
    `${source}:refs/heads/staged/v1.0`,
    `${source}:refs/heads/calibration/g1/reconciliation/no-late/line`,
    `${source}:refs/heads/calibration/g1/conflict-recovery/line`,
  ]);
  command(seed, ['tag', '-a', 'v1.0.0', source, '-m', 'retained release tag']);
  command(seed, ['push', 'origin', 'refs/tags/v1.0.0']);
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

function gitOptions(f) {
  return { cwd: f.runner, acceptedRemoteUrls: [f.remote] };
}

function remoteRef(f, ref) {
  const output = command(f.runner, ['ls-remote', f.remote, ref]);
  return output ? output.split(/\s+/)[0] : null;
}

function checkout(f, ref) {
  command(f.runner, ['checkout', '--detach', ref]);
}

function checkoutMain(f) {
  command(f.runner, ['checkout', 'main']);
}

class RecordingGit extends Git {
  constructor(options) {
    super(options);
    this.pushes = [];
    this.advertisements = [];
  }

  run(args, options) {
    if (args[0] === 'push') this.pushes.push([...args]);
    if (args[0] === 'ls-remote') this.advertisements.push([...args]);
    return super.run(args, options);
  }
}

function assertSafePushes(pushes) {
  assert.ok(pushes.length > 0);
  const allowed = new Set(ROLES.map(calibrationRef));
  for (const args of pushes) {
    assert.equal(args[0], 'push');
    assert.ok(args.includes('--porcelain'));
    assert.ok(args.includes('--no-follow-tags'));
    assert.ok(!args.includes('--delete'));
    const remoteIndex = args.indexOf('origin');
    assert.ok(remoteIndex > 0);
    const leases = args.filter((arg) => arg.startsWith('--force-with-lease='));
    const atomic = args.includes('--atomic');
    assert.equal(leases.length, atomic ? 2 : 1);
    const refspecs = args.slice(remoteIndex + 1);
    assert.equal(refspecs.length, atomic ? 2 : 1);
    for (const refspec of refspecs) {
      const [source, destination, extra] = refspec.split(':');
      assert.match(source, /^[0-9a-f]{40}$/);
      assert.ok(allowed.has(destination));
      assert.equal(extra, undefined);
      assert.ok(leases.some((lease) => lease.startsWith(`--force-with-lease=${destination}:`)));
    }
    if (atomic) {
      assert.deepEqual(
        refspecs.map((refspec) => refspec.split(':')[1]).sort(),
        [calibrationRef('approved'), calibrationRef('head')].sort(),
      );
    }
  }
}

function parseWorkflowYaml(yaml) {
  const ruby = [
    'document = Psych.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false)',
    'raise "ambiguous on keys" if document.key?("on") && document.key?(true)',
    'trigger = document.key?("on") ? document["on"] : document[true]',
    'document["on"] = trigger',
    'document.delete(true)',
    'puts JSON.generate(document)',
  ].join('; ');
  return JSON.parse(
    execFileSync('ruby', ['-rpsych', '-rjson', '-e', ruby], { input: yaml, encoding: 'utf8' }),
  );
}

const EXPECTED_STATE_WORKFLOW = {
  name: 'Calibrate required-check state',
  on: {
    workflow_dispatch: {
      inputs: {
        mode: {
          description: 'Fixed required-check state transition',
          required: true,
          type: 'choice',
          options: ['setup', 'advance-head', 'approve-head'],
        },
      },
    },
  },
  permissions: { contents: 'write' },
  concurrency: { group: 'calibration-g1-required-check-state', 'cancel-in-progress': false },
  jobs: {
    'maintain-state': {
      name: 'Maintain required-check calibration state',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
      steps: [
        {
          name: 'Assert the fixed laboratory target',
          run:
            'test "$GITHUB_REPOSITORY" = "fablebookjs/lab-01"\n' +
            'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"\n' +
            'test "$GITHUB_REF" = "refs/heads/main"\n',
        },
        {
          name: 'Check out trusted main code',
          uses: 'actions/checkout@v7',
          with: { 'fetch-depth': 0, 'persist-credentials': true, ref: '${{ github.sha }}' },
        },
        {
          name: 'Maintain the fixed required-check graph',
          run: 'node scripts/calibrate-required-check-state.mjs --mode "$MODE"',
          env: { MODE: '${{ inputs.mode }}' },
        },
      ],
    },
  },
};

const EXPECTED_CHECK_WORKFLOW = {
  name: 'Required check calibration',
  on: { workflow_dispatch: null },
  permissions: { contents: 'read' },
  concurrency: {
    group: 'calibration-g1-required-check-${{ github.sha }}',
    'cancel-in-progress': false,
  },
  jobs: {
    'current-head-authorization': {
      name: 'Required calibration head',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      steps: [
        {
          name: 'Assert the fixed calibration head',
          run:
            'test "$GITHUB_REPOSITORY" = "fablebookjs/lab-01"\n' +
            'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"\n' +
            'test "$GITHUB_REF" = "refs/heads/calibration/g1/required-check/head"\n',
        },
        {
          name: 'Check out the exact dispatched calibration head',
          uses: 'actions/checkout@v7',
          with: { 'fetch-depth': 1, 'persist-credentials': false, ref: '${{ github.sha }}' },
        },
        {
          name: 'Require the exact current and approved head',
          run: 'node scripts/check-required-calibration-head.mjs',
        },
      ],
    },
  },
};

function assertExactWorkflows(stateYaml, checkYaml) {
  assert.deepEqual(parseWorkflowYaml(stateYaml), EXPECTED_STATE_WORKFLOW);
  assert.deepEqual(parseWorkflowYaml(checkYaml), EXPECTED_CHECK_WORKFLOW);
}

test('setup creates only the deterministic five-ref graph and preserves all retained evidence', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const first = runStateCalibration({ mode: 'setup', git, source: f.source });
    assert.equal(first.state.head, first.graph.a);
    assert.equal(first.state.approved, first.graph.a);
    assert.equal(command(f.runner, ['show', `${first.graph.a}:${FILE_PATH}`]), 'required-check calibration A');
    assert.equal(command(f.runner, ['show', `${first.graph.b}:${FILE_PATH}`]), 'required-check calibration B');
    assert.deepEqual(
      command(f.runner, ['show', '-s', '--format=%P', first.graph.base]).split(' '),
      [f.source],
    );
    assert.equal(command(f.runner, ['show', '-s', '--format=%P', first.graph.a]), first.graph.base);
    assert.equal(command(f.runner, ['show', '-s', '--format=%P', first.graph.b]), first.graph.a);
    assertSafePushes(git.pushes);

    const requiredRefs = command(f.runner, ['ls-remote', '--heads', f.remote, `${NAMESPACE}/*`])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1]);
    assert.deepEqual(requiredRefs.sort(), ROLES.map(calibrationRef).sort());
    for (const ref of [
      'refs/heads/releases/v1.0',
      'refs/heads/staged/v1.0',
      'refs/heads/calibration/g1/reconciliation/no-late/line',
      'refs/heads/calibration/g1/conflict-recovery/line',
    ]) {
      assert.equal(remoteRef(f, ref), f.source);
    }
    assert.notEqual(remoteRef(f, 'refs/tags/v1.0.0'), null);
    assert.equal(command(f.runner, ['rev-list', '-n', '1', 'v1.0.0']), f.source);

    const pushCount = git.pushes.length;
    const rerun = runStateCalibration({ mode: 'setup', git, source: f.source });
    assert.deepEqual(rerun.graph, first.graph);
    assert.deepEqual(rerun.state, first.state);
    assert.equal(git.pushes.length, pushCount);
  } finally {
    f.cleanup();
  }
});

test('A green, head B with approval A, and approved B produce the required exact-SHA sequence', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });

    checkout(f, setup.graph.a);
    const aCheck = evaluateRequiredHead({ git, headSha: setup.graph.a });
    assert.equal(aCheck.authorized, true);
    assert.equal(aCheck.reason, 'current-head-is-exactly-approved');

    checkoutMain(f);
    const advanced = runStateCalibration({ mode: 'advance-head', git, source: f.source });
    assert.equal(advanced.state.head, setup.graph.b);
    assert.equal(advanced.state.approved, setup.graph.a);

    checkout(f, setup.graph.a);
    const staleA = evaluateRequiredHead({ git, headSha: setup.graph.a });
    assert.equal(staleA.authorized, false);
    assert.equal(staleA.reason, 'dispatched-sha-is-not-current-remote-head');

    checkout(f, setup.graph.b);
    const unapprovedB = evaluateRequiredHead({ git, headSha: setup.graph.b });
    assert.equal(unapprovedB.authorized, false);
    assert.equal(unapprovedB.reason, 'current-head-is-not-approved');

    checkoutMain(f);
    const approved = runStateCalibration({ mode: 'approve-head', git, source: f.source });
    assert.equal(approved.state.head, setup.graph.b);
    assert.equal(approved.state.approved, setup.graph.b);

    checkout(f, setup.graph.b);
    const currentB = evaluateRequiredHead({ git, headSha: setup.graph.b });
    assert.equal(currentB.authorized, true);
    assert.equal(currentB.reason, 'current-head-is-exactly-approved');
  } finally {
    f.cleanup();
  }
});

test('advance and approve reruns converge without rewrites or backwards transitions', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
    const setupPushes = git.pushes.length;
    runStateCalibration({ mode: 'advance-head', git, source: f.source });
    const advancePushes = git.pushes.length;
    assert.equal(advancePushes, setupPushes + 1);
    const advanceRerun = runStateCalibration({ mode: 'advance-head', git, source: f.source });
    assert.equal(advanceRerun.transition.head, 'reused');
    assert.equal(git.pushes.length, advancePushes);
    runStateCalibration({ mode: 'approve-head', git, source: f.source });
    const approvePushes = git.pushes.length;
    assert.equal(approvePushes, advancePushes + 1);
    const approveRerun = runStateCalibration({ mode: 'approve-head', git, source: f.source });
    assert.equal(approveRerun.transition.approved, 'reused');
    assert.equal(git.pushes.length, approvePushes);
    const setupRerun = runStateCalibration({ mode: 'setup', git, source: f.source });
    assert.deepEqual(setupRerun.state, { head: setup.graph.b, approved: setup.graph.b });
    assert.equal(git.pushes.length, approvePushes);
    assertSafePushes(git.pushes);
  } finally {
    f.cleanup();
  }
});

test('approval atomically retains exact head B while advancing only approved A to B', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
    runStateCalibration({ mode: 'advance-head', git, source: f.source });
    const before = git.pushes.length;
    const result = runStateCalibration({ mode: 'approve-head', git, source: f.source });
    assert.equal(result.transition.approved, 'advanced');
    assert.equal(git.pushes.length, before + 1);
    const approval = git.pushes.at(-1);
    assert.ok(approval.includes('--atomic'));
    assert.ok(approval.includes(`--force-with-lease=${calibrationRef('head')}:${setup.graph.b}`));
    assert.ok(approval.includes(`--force-with-lease=${calibrationRef('approved')}:${setup.graph.a}`));
    assert.deepEqual(approval.slice(approval.indexOf('origin') + 1), [
      `${setup.graph.b}:${calibrationRef('head')}`,
      `${setup.graph.b}:${calibrationRef('approved')}`,
    ]);
    assertSafePushes([approval]);
  } finally {
    f.cleanup();
  }
});

test('approval head rewind, deletion, and unexpected replacement races reject without advancing approval', () => {
  for (const race of ['rewind', 'delete', 'replace']) {
    const f = fixture();
    try {
      const setupGit = new Git(gitOptions(f));
      const setup = runStateCalibration({ mode: 'setup', git: setupGit, source: f.source });
      runStateCalibration({ mode: 'advance-head', git: setupGit, source: f.source });
      const unexpected = command(f.runner, [
        'commit-tree',
        `${f.source}^{tree}`,
        '-p',
        f.source,
        '-m',
        `approval ${race} winner`,
      ], {
        GIT_AUTHOR_NAME: 'Approval Race',
        GIT_AUTHOR_EMAIL: 'approval-race@example.invalid',
        GIT_AUTHOR_DATE: '2026-07-15T16:10:00Z',
        GIT_COMMITTER_NAME: 'Approval Race',
        GIT_COMMITTER_EMAIL: 'approval-race@example.invalid',
        GIT_COMMITTER_DATE: '2026-07-15T16:10:00Z',
      });

      class ApprovalRaceGit extends RecordingGit {
        raced = false;

        run(args, options) {
          if (!this.raced && args[0] === 'push' && args.includes('--atomic')) {
            this.raced = true;
            const source = race === 'rewind' ? setup.graph.a : race === 'replace' ? unexpected : '';
            command(f.runner, ['push', '--force', f.remote, `${source}:${calibrationRef('head')}`]);
          }
          return super.run(args, options);
        }
      }

      const git = new ApprovalRaceGit(gitOptions(f));
      assert.throws(
        () => runStateCalibration({ mode: 'approve-head', git, source: f.source }),
        /Atomic approval was rejected/,
        race,
      );
      const expectedHead = race === 'rewind' ? setup.graph.a : race === 'replace' ? unexpected : null;
      assert.equal(remoteRef(f, calibrationRef('head')), expectedHead, race);
      assert.equal(remoteRef(f, calibrationRef('approved')), setup.graph.a, race);
      assert.equal(git.pushes.length, 1, race);
      assertSafePushes(git.pushes);
    } finally {
      f.cleanup();
    }
  }
});

test('ambiguous approval failure converges by exact coupled-state readback and rerun is query-only', () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git: setupGit, source: f.source });
    runStateCalibration({ mode: 'advance-head', git: setupGit, source: f.source });

    class LostApprovalSuccessGit extends RecordingGit {
      injected = false;

      run(args, options) {
        if (!this.injected && args[0] === 'push' && args.includes('--atomic')) {
          this.injected = true;
          command(f.runner, [
            'push',
            '--force',
            f.remote,
            `${setup.graph.b}:${calibrationRef('approved')}`,
          ]);
          this.pushes.push([...args]);
          return { status: 1, stdout: '', stderr: 'simulated lost success response' };
        }
        return super.run(args, options);
      }
    }

    const git = new LostApprovalSuccessGit(gitOptions(f));
    const first = runStateCalibration({ mode: 'approve-head', git, source: f.source });
    assert.equal(first.transition.approved, 'approved-lost-success');
    assert.deepEqual(first.state, { head: setup.graph.b, approved: setup.graph.b });
    const pushes = git.pushes.length;
    const rerun = runStateCalibration({ mode: 'approve-head', git, source: f.source });
    assert.equal(rerun.transition.approved, 'reused');
    assert.equal(git.pushes.length, pushes);
  } finally {
    f.cleanup();
  }
});

test('a competing incompatible approval rejects the atomic transition without moving head', () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git: setupGit, source: f.source });
    runStateCalibration({ mode: 'advance-head', git: setupGit, source: f.source });
    const unexpected = command(f.runner, [
      'commit-tree',
      `${f.source}^{tree}`,
      '-p',
      f.source,
      '-m',
      'competing approval',
    ], {
      GIT_AUTHOR_NAME: 'Competing Approval',
      GIT_AUTHOR_EMAIL: 'competing-approval@example.invalid',
      GIT_AUTHOR_DATE: '2026-07-15T16:15:00Z',
      GIT_COMMITTER_NAME: 'Competing Approval',
      GIT_COMMITTER_EMAIL: 'competing-approval@example.invalid',
      GIT_COMMITTER_DATE: '2026-07-15T16:15:00Z',
    });

    class CompetingApprovalGit extends RecordingGit {
      injected = false;

      run(args, options) {
        if (!this.injected && args[0] === 'push' && args.includes('--atomic')) {
          this.injected = true;
          command(f.runner, [
            'push',
            '--force',
            f.remote,
            `${unexpected}:${calibrationRef('approved')}`,
          ]);
        }
        return super.run(args, options);
      }
    }

    const git = new CompetingApprovalGit(gitOptions(f));
    assert.throws(
      () => runStateCalibration({ mode: 'approve-head', git, source: f.source }),
      /Atomic approval was rejected/,
    );
    assert.equal(remoteRef(f, calibrationRef('head')), setup.graph.b);
    assert.equal(remoteRef(f, calibrationRef('approved')), unexpected);
    assertSafePushes(git.pushes);
  } finally {
    f.cleanup();
  }
});

test('approval before head B and source drift both fail closed without a state write', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    runStateCalibration({ mode: 'setup', git, source: f.source });
    const pushes = git.pushes.length;
    assert.throws(
      () => runStateCalibration({ mode: 'approve-head', git, source: f.source }),
      /Cannot approve B before calibration head is exact B/,
    );
    assert.equal(git.pushes.length, pushes);

    writeFileSync(join(f.root, 'seed', 'drift.txt'), 'remote main drift\n');
    command(join(f.root, 'seed'), ['add', 'drift.txt']);
    command(join(f.root, 'seed'), ['commit', '-m', 'advance main'], {
      GIT_AUTHOR_DATE: '2026-07-15T15:30:00Z',
      GIT_COMMITTER_DATE: '2026-07-15T15:30:00Z',
    });
    command(join(f.root, 'seed'), ['push', 'origin', 'main']);
    assert.throws(
      () => runStateCalibration({ mode: 'advance-head', git, source: f.source }),
      /Remote refs\/heads\/main .* is not trusted source/,
    );
    assert.equal(git.pushes.length, pushes);
    assert.equal(remoteRef(f, calibrationRef('head')), createGraph(git, f.source).a);
  } finally {
    f.cleanup();
  }
});

test('an exact old-SHA race rejects the update and preserves the unexpected winning head', () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git: setupGit, source: f.source });
    const unexpected = command(f.runner, [
      'commit-tree',
      `${f.source}^{tree}`,
      '-p',
      f.source,
      '-m',
      'unexpected race winner',
    ], {
      GIT_AUTHOR_NAME: 'Race',
      GIT_AUTHOR_EMAIL: 'race@example.invalid',
      GIT_AUTHOR_DATE: '2026-07-15T15:45:00Z',
      GIT_COMMITTER_NAME: 'Race',
      GIT_COMMITTER_EMAIL: 'race@example.invalid',
      GIT_COMMITTER_DATE: '2026-07-15T15:45:00Z',
    });

    class RacingGit extends RecordingGit {
      raced = false;

      run(args, options) {
        if (
          !this.raced &&
          args[0] === 'push' &&
          args.at(-1) === `${setup.graph.b}:${calibrationRef('head')}`
        ) {
          this.raced = true;
          command(f.runner, ['push', '--force', f.remote, `${unexpected}:${calibrationRef('head')}`]);
        }
        return super.run(args, options);
      }
    }

    const git = new RacingGit(gitOptions(f));
    assert.throws(
      () => runStateCalibration({ mode: 'advance-head', git, source: f.source }),
      /Guarded update .* was rejected; observed/,
    );
    assert.equal(remoteRef(f, calibrationRef('head')), unexpected);
    assert.equal(remoteRef(f, calibrationRef('approved')), setup.graph.a);
    assertSafePushes(git.pushes);
  } finally {
    f.cleanup();
  }
});

test('graph verification rejects a forged A outside the fixed path', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const graph = createGraph(git, f.source);
    writeFileSync(join(f.runner, 'outside.txt'), 'forged\n');
    command(f.runner, ['add', 'outside.txt']);
    const forgedTree = command(f.runner, ['write-tree']);
    const forgedA = command(f.runner, ['commit-tree', forgedTree, '-p', graph.base, '-m', 'forged A'], {
      GIT_AUTHOR_NAME: 'Forge',
      GIT_AUTHOR_EMAIL: 'forge@example.invalid',
      GIT_AUTHOR_DATE: '2026-07-15T16:00:00Z',
      GIT_COMMITTER_NAME: 'Forge',
      GIT_COMMITTER_EMAIL: 'forge@example.invalid',
      GIT_COMMITTER_DATE: '2026-07-15T16:00:00Z',
    });
    assert.throws(() => verifyGraph(git, { ...graph, a: forgedA }), /B parent is not exact A|canonical fixed/);
  } finally {
    f.cleanup();
  }
});

test('every write helper rejects refs outside the exact five-name set before Git runs', () => {
  let calls = 0;
  const git = {
    assertTrustedRemote() {
      calls += 1;
    },
    run() {
      calls += 1;
    },
  };
  for (const ref of [
    'refs/heads/releases/v1.0',
    'refs/heads/staged/v1.0',
    `${NAMESPACE}/other`,
    `${NAMESPACE}/../head`,
    'refs/tags/v1.0.1',
  ]) {
    assert.throws(() => assertCalibrationRef(ref), /outside the exact/);
    assert.throws(() => pushWithLease(git, ref, null, '1'.repeat(40)), /outside the exact/);
  }
  assert.throws(() => calibrationRef('line'), /Unsupported/);
  assert.equal(calls, 0);
});

test('one strict advertisement parser rejects malformed, duplicate, missing, and unknown records', () => {
  const main = 'refs/heads/main';
  const head = calibrationRef('head');
  const sha = '1'.repeat(40);
  assert.deepEqual(parseRemoteAdvertisement(`${sha}\t${main}\n`, [main]), { [main]: sha });
  assert.deepEqual(parseRemoteAdvertisement('', [main]), { [main]: null });
  for (const output of [
    `${sha}\t${main}\textra\n`,
    `${sha} ${main}\n`,
    `${sha}\t${main}\n${sha}\t${main}\n`,
    `${sha}\t${head}\n`,
    `${'z'.repeat(40)}\t${main}\n`,
    `${sha}\t${main} trailing\n`,
  ]) {
    assert.throws(() => parseRemoteAdvertisement(output, [main]), /Malformed|Duplicate|Unexpected/);
  }
  assert.throws(() => parseRemoteAdvertisement('', [main, main]), /unique requested refs/);

  class ForgedMainAdvertisementGit extends Git {
    assertTrustedRemote() {}
    text(args) {
      if (args[0] === 'ls-remote') return `${sha}\t${main}\tattacker-extra`;
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    }
  }
  assert.throws(() => new ForgedMainAdvertisementGit().remoteMain(), /Malformed remote advertisement/);
});

test('hostile Git environment and every local transport or credential override fail before advertisement', () => {
  const f = fixture();
  const outside = join(f.root, 'outside.git');
  try {
    command(f.root, ['init', '--bare', outside]);
    const previous = process.env.GIT_EXEC_PATH;
    class CountingGit extends Git {
      calls = 0;
      run(args, options) {
        this.calls += 1;
        return super.run(args, options);
      }
    }
    process.env.GIT_EXEC_PATH = join(f.root, 'attacker-git-helpers');
    const hostile = new CountingGit(gitOptions(f));
    try {
      assert.throws(
        () => runStateCalibration({ mode: 'setup', git: hostile, source: f.source }),
        /Hostile inherited Git environment: GIT_EXEC_PATH/,
      );
      assert.equal(hostile.calls, 0);
      assert.throws(
        () => evaluateRequiredHead({ git: hostile, headSha: f.source }),
        /Hostile inherited Git environment: GIT_EXEC_PATH/,
      );
      assert.equal(hostile.calls, 0);
    } finally {
      if (previous === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = previous;
    }

    command(f.runner, ['config', 'remote.origin.pushurl', outside]);
    const pushUrlGit = new RecordingGit(gitOptions(f));
    assert.throws(
      () => runStateCalibration({ mode: 'setup', git: pushUrlGit, source: f.source }),
      /Unsafe repository Git config: remote\.origin\.pushurl/,
    );
    assert.equal(pushUrlGit.pushes.length, 0);
    assert.equal(pushUrlGit.advertisements.length, 0);
    command(f.runner, ['config', '--unset-all', 'remote.origin.pushurl']);

    const rewriteKey = `url.${outside}.pushInsteadOf`;
    command(f.runner, ['config', rewriteKey, f.remote]);
    const rewriteGit = new RecordingGit(gitOptions(f));
    assert.throws(
      () => runStateCalibration({ mode: 'setup', git: rewriteGit, source: f.source }),
      /Unsafe repository Git config: url\./,
    );
    assert.equal(rewriteGit.pushes.length, 0);
    assert.equal(rewriteGit.advertisements.length, 0);
    command(f.runner, ['config', '--unset-all', rewriteKey]);

    for (const [key, value] of [
      ['http.proxy', 'http://127.0.0.1:9'],
      ['http.sslVerify', 'false'],
      ['http.sslCAInfo', join(f.root, 'attacker-ca.pem')],
      ['http.sslCert', join(f.root, 'attacker-cert.pem')],
      ['http.lowSpeedLimit', '1'],
      ['credential.helper', `!touch ${join(f.root, 'credential-helper-ran')}`],
      ['remote.origin.proxy', 'http://127.0.0.1:9'],
      ['remote.origin.uploadpack', join(f.root, 'attacker-upload-pack')],
      ['remote.origin.receivepack', join(f.root, 'attacker-receive-pack')],
      ['core.gitProxy', join(f.root, 'attacker-git-proxy')],
    ]) {
      command(f.runner, ['config', key, value]);
      const stateGit = new RecordingGit(gitOptions(f));
      assert.throws(
        () => runStateCalibration({ mode: 'setup', git: stateGit, source: f.source }),
        new RegExp(`Unsafe repository Git config: ${key.replaceAll('.', '\\.')}`, 'i'),
        key,
      );
      assert.equal(stateGit.advertisements.length, 0, key);
      assert.equal(stateGit.pushes.length, 0, key);
      const checkGit = new RecordingGit(gitOptions(f));
      assert.throws(
        () => evaluateRequiredHead({ git: checkGit, headSha: f.source }),
        /Unsafe repository Git config/,
        key,
      );
      assert.equal(checkGit.advertisements.length, 0, key);
      command(f.runner, ['config', '--unset-all', key]);
    }
    assert.equal(existsSync(join(f.root, 'credential-helper-ran')), false);

    command(f.runner, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic first']);
    command(f.runner, [
      'config',
      'http.https://github.com/fablebookjs/lab-01.extraheader',
      'AUTHORIZATION: basic second',
    ]);
    const duplicateAuth = new RecordingGit(gitOptions(f));
    assert.throws(
      () => runStateCalibration({ mode: 'setup', git: duplicateAuth, source: f.source }),
      /Only one scoped checkout authentication entry is allowed/,
    );
    assert.equal(duplicateAuth.advertisements.length, 0);
    assert.equal(duplicateAuth.pushes.length, 0);
  } finally {
    f.cleanup();
  }
});

test('global config is isolated and system or command-scope config overrides are rejected before Git', () => {
  const f = fixture();
  const globalHome = join(f.root, 'global-home');
  const systemConfig = join(f.root, 'system.gitconfig');
  const marker = join(f.root, 'global-credential-helper-ran');
  mkdirSync(globalHome);
  try {
    command(f.root, ['config', '--global', 'http.proxy', 'http://127.0.0.1:9'], { HOME: globalHome });
    command(f.root, ['config', '--global', 'http.sslVerify', 'false'], { HOME: globalHome });
    command(f.root, ['config', '--global', 'credential.helper', `!touch ${marker}`], { HOME: globalHome });
    const previousHome = process.env.HOME;
    process.env.HOME = globalHome;
    try {
      const git = new RecordingGit(gitOptions(f));
      const globalProbe = git.run(['config', '--global', '--get', 'http.proxy'], { allowFailure: true });
      assert.equal(globalProbe.status, 1);
      const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
      assert.ok(git.advertisements.length > 0);
      checkout(f, setup.graph.a);
      const checkGit = new RecordingGit(gitOptions(f));
      assert.equal(evaluateRequiredHead({ git: checkGit, headSha: setup.graph.a }).authorized, true);
      assert.ok(checkGit.advertisements.length > 0);
      checkoutMain(f);
      assert.equal(existsSync(marker), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    writeFileSync(systemConfig, '[http]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n');
    for (const [key, value] of [
      ['GIT_CONFIG_SYSTEM', systemConfig],
      ['GIT_CONFIG_GLOBAL', join(globalHome, '.gitconfig')],
      ['GIT_CONFIG_COUNT', '0'],
      ['GIT_CONFIG_PARAMETERS', "'http.proxy'='http://127.0.0.1:9'"],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      const git = new RecordingGit(gitOptions(f));
      try {
        assert.throws(
          () => runStateCalibration({ mode: 'setup', git, source: f.source }),
          new RegExp(`Hostile inherited Git environment: ${key}`),
        );
        assert.equal(git.advertisements.length, 0, key);
        assert.equal(git.pushes.length, 0, key);
        const checkGit = new RecordingGit(gitOptions(f));
        assert.throws(
          () => evaluateRequiredHead({ git: checkGit, headSha: f.source }),
          new RegExp(`Hostile inherited Git environment: ${key}`),
        );
        assert.equal(checkGit.advertisements.length, 0, key);
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  } finally {
    f.cleanup();
  }
});

test('push.followTags cannot escape the namespace and checkout auth remains intact', () => {
  const f = fixture();
  try {
    command(f.runner, ['config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic retained']);
    command(f.runner, ['config', 'push.followTags', 'true']);
    command(f.runner, ['tag', '-a', 'must-not-follow', f.source, '-m', 'must not follow']);
    const git = new RecordingGit(gitOptions(f));
    runStateCalibration({ mode: 'setup', git, source: f.source });
    assertSafePushes(git.pushes);
    assert.equal(remoteRef(f, 'refs/tags/must-not-follow'), null);
    assert.equal(
      command(f.runner, ['config', '--get', 'http.https://github.com/.extraheader']),
      'AUTHORIZATION: basic retained',
    );
  } finally {
    f.cleanup();
  }
});

test('workflows have exact manual triggers, isolated permissions, and one stable check context', () => {
  const stateYaml = readFileSync(
    new URL('../.github/workflows/calibrate-required-check-state.yml', import.meta.url),
    'utf8',
  );
  const checkYaml = readFileSync(
    new URL('../.github/workflows/calibrate-required-check.yml', import.meta.url),
    'utf8',
  );
  assertExactWorkflows(stateYaml, checkYaml);

  const stateMutants = [
    stateYaml.replace('on:\n', '"on": { workflow_dispatch: null }\non:\n'),
    stateYaml.replace('  workflow_dispatch:', '  workflow_dispatch:\n  pull_request:'),
    stateYaml.replace('permissions:\n  contents: write', 'permissions: { contents: write, pull-requests: write }'),
    stateYaml.replace('    runs-on: ubuntu-latest', '    permissions: read-all\n    runs-on: ubuntu-latest'),
    stateYaml.replace('    runs-on: ubuntu-latest', '    "permissions": { contents: write }\n    runs-on: ubuntu-latest'),
    stateYaml.replace(
      'jobs:\n',
      'jobs:\n  injected: { runs-on: ubuntu-latest, steps: [{ run: "gh api repos/fablebookjs/lab-01/pulls" }] }\n',
    ),
    stateYaml.replace(
      '      - name: Maintain the fixed required-check graph',
      '      - { name: Unsafe API, run: "gh api repos/fablebookjs/lab-01/branches/main/protection" }\n' +
        '      - name: Maintain the fixed required-check graph',
    ),
    stateYaml.replace('persist-credentials: true', 'persist-credentials: false'),
    stateYaml.replace('fetch-depth: 0', 'fetch-depth: 1'),
    stateYaml.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    stateYaml.replace('node scripts/calibrate-required-check-state.mjs --mode "$MODE"', 'git push origin HEAD:main'),
  ];
  for (const mutant of stateMutants) {
    assert.throws(() => assertExactWorkflows(mutant, checkYaml));
  }

  const checkMutants = [
    checkYaml.replace('  workflow_dispatch:', '  workflow_dispatch:\n  push:'),
    checkYaml.replace('permissions:\n  contents: read', 'permissions: { contents: write }'),
    checkYaml.replace('    runs-on: ubuntu-latest', '    permissions: { statuses: write }\n    runs-on: ubuntu-latest'),
    checkYaml.replace(
      'jobs:\n',
      'jobs:\n  injected: { runs-on: ubuntu-latest, steps: [{ run: "curl https://api.github.com" }] }\n',
    ),
    checkYaml.replace(
      '      - name: Require the exact current and approved head',
      '      - { name: Unsafe merge, run: "gh pr merge --merge" }\n' +
        '      - name: Require the exact current and approved head',
    ),
    checkYaml.replace('persist-credentials: false', 'persist-credentials: true'),
    checkYaml.replace('Required calibration head', 'Different context'),
    checkYaml.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
  ];
  for (const mutant of checkMutants) {
    assert.throws(() => assertExactWorkflows(stateYaml, mutant));
  }
});

test('scripts and documentation retain the release boundary and do not claim live proof', () => {
  const stateScript = readFileSync(
    new URL('../scripts/calibrate-required-check-state.mjs', import.meta.url),
    'utf8',
  );
  const checkScript = readFileSync(
    new URL('../scripts/check-required-calibration-head.mjs', import.meta.url),
    'utf8',
  );
  const docs = readFileSync(new URL('../docs/required-check-calibration.md', import.meta.url), 'utf8');
  for (const script of [stateScript, checkScript]) {
    assert.doesNotMatch(script, /releases\/v1\.0|staged\/v1\.0|\/pulls|refs\/tags|\bnpm\b|storybook/i);
    assert.doesNotMatch(
      script,
      /api\.github\.com|\bgh\s+api\b|\bgh\s+pr\b|\bcurl\b|\/branches\/.*\/protection|\/merge(?:s|d)?\b/i,
    );
    assert.doesNotMatch(script, /\bfetch\s*\(|https?\.request\s*\(|spawnSync\((?!'git')/);
  }
  assert.equal(stateScript.match(/spawnSync\('git'/g)?.length, 1);
  assert.equal(checkScript.match(/spawnSync\(/g), null);
  assert.match(docs, /does not\s+claim that behavior has been proved until the complete live sequence/);
  assert.match(docs, /required_status_checks\.strict=false/);
  assert.match(docs, /enforce_admins\.enabled=true/);
  assert.match(docs, /required_status_checks\.checks=\[\{context: CONTEXT, app_id: APP_ID\}\]/);
  assert.match(docs, /headRefOid/);
  assert.match(docs, /statusCheckRollup/);
  assert.match(docs, /mergeStateStatus/);
  assert.match(docs, /`\(MERGEABLE, CLEAN, SUCCESS\)`/);
  assert.match(docs, /`\(MERGEABLE, BLOCKED, null\)`/);
  assert.match(docs, /`\(MERGEABLE, UNSTABLE, FAILURE\)`/);
  assert.match(docs, /app\.slug.*`github-actions`/s);
  assert.match(docs, /--paginate \\\n  --slurp/);
  assert.match(docs, /filter=all&per_page=100/);
  assert.match(docs, /sort_by\(\.id\) \| last \| select\(\. != null\)/);
  assert.match(docs, /\.required_status_checks\.checks \| length/);
  assert.match(docs, /every five seconds, for at most five minutes/);
  assert.match(docs, /number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null/);
  assert.match(docs, /Never merge, close, or draft this PR/);
  assert.match(docs, /release PR #12/);
  assert.match(docs, /conflict-recovery PR #16/);
  assert.match(docs, /same context\/App pair green/);
});
