import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import {
  AUTHORIZATION_PREFIX,
  evaluatePullRequestHead,
  parseAuthorizedHead,
  readPullRequestEvent,
} from '../scripts/check-required-calibration-head.mjs';

const V1_NAMESPACE = 'refs/heads/calibration/g1/required-check';
const V2_NAMESPACE = 'refs/heads/calibration/g1/required-check-pr';
const BRANCH_NAMESPACE = 'calibration/g1/required-check-current';
const HUMAN_EDITED_RUN_SELECTOR = `
[.workflow_runs[] | . as $run |
 select(([$before[0].workflow_runs[].id] | index($run.id)) == null) |
 select(.event == "pull_request" and
        .actor.login == "ndelangen" and
        .path == ".github/workflows/calibrate-required-check.yml" and
        .head_branch == "calibration/g1/required-check-current/head" and
        .head_sha == $head and
        .status == "completed" and
        .conclusion == $conclusion)] as $runs |
select(($runs | length) == 1) | $runs[0]
`.trim();
const CHECKER_EVIDENCE_SELECTOR = `
.action == "edited" and
.number == $number and
.headSha == $head and
.remoteHeadSha == $head and
.remoteMergeSha == $merge and
.authorizedSha == $authorized
`.trim();
const B_BEFORE_EDIT_POLICY_SELECTOR = `
.repository.pullRequest as $pr |
$pr.mergeable == "MERGEABLE" and
$pr.mergeStateStatus == "BLOCKED" and
$pr.headRefOid == $head and
$pr.commits.nodes[0].commit.statusCheckRollup == null
`.trim();
const B_AFTER_EDIT_POLICY_SELECTOR = `
.repository.pullRequest as $pr |
$pr.mergeable == "MERGEABLE" and
$pr.mergeStateStatus == "CLEAN" and
$pr.headRefOid == $head and
$pr.commits.nodes[0].commit.statusCheckRollup.state == "SUCCESS"
`.trim();
const REQUIRED_CONTEXT_CHECK_SELECTOR = `
[.[].check_runs[] |
 select(.head_sha == $head and
        .name == $context and
        .app.id == $app_id)]
`.trim();

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
    `${source}:${V1_NAMESPACE}/base`,
    `${source}:${V1_NAMESPACE}/a`,
    `${source}:${V1_NAMESPACE}/b`,
    `${source}:${V1_NAMESPACE}/head`,
    `${source}:${V2_NAMESPACE}/base`,
    `${source}:${V2_NAMESPACE}/a`,
    `${source}:${V2_NAMESPACE}/b`,
    `${source}:${V2_NAMESPACE}/head`,
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

function updateRemoteRef(f, ref, sha) {
  command(f.runner, ['push', '--force', '--no-follow-tags', f.remote, `${sha}:${ref}`]);
}

function deleteRemoteRef(f, ref) {
  command(f.runner, ['push', '--no-follow-tags', f.remote, `:${ref}`]);
}

function setPullMergeRef(f, number, sha) {
  updateRemoteRef(f, `refs/pull/${number}/merge`, sha);
}

function checkout(f, ref) {
  command(f.runner, ['checkout', '--detach', ref]);
}

function checkoutMain(f) {
  command(f.runner, ['checkout', 'main']);
}

function authorizedBody(sha) {
  return `Retained calibration authorization.\n\n${AUTHORIZATION_PREFIX} ${sha}`;
}

function pullRequestEvent({
  action,
  baseSha,
  headSha,
  authorizedSha = headSha,
  body = authorizedBody(authorizedSha),
  number = 20,
  before,
  repository = 'fablebookjs/lab-01',
  baseRepository = repository,
  headRepository = repository,
  baseRef = `${BRANCH_NAMESPACE}/base`,
  headRef = `${BRANCH_NAMESPACE}/head`,
  draft = false,
  merged = false,
  mergedAt = null,
  state = 'open',
} = {}) {
  const event = {
    action,
    number,
    repository: { full_name: repository },
    pull_request: {
      number,
      state,
      draft,
      merged,
      merged_at: mergedAt,
      body,
      base: { ref: baseRef, sha: baseSha, repo: { full_name: baseRepository } },
      head: { ref: headRef, sha: headSha, repo: { full_name: headRepository } },
    },
  };
  if (action === 'edited') {
    event.changes = { body: { from: authorizedBody(before) } };
  }
  return event;
}

function evaluateEvent(git, event, overrides = {}) {
  return evaluatePullRequestHead({
    git,
    event,
    repository: 'fablebookjs/lab-01',
    eventName: 'pull_request',
    githubRef: `refs/pull/${event.number}/merge`,
    githubSha: event.pull_request.head.sha,
    baseRef: `${BRANCH_NAMESPACE}/base`,
    headRef: `${BRANCH_NAMESPACE}/head`,
    ...overrides,
  });
}

class RecordingGit extends Git {
  constructor(options) {
    super(options);
    this.pushes = [];
    this.advertisements = [];
    this.networkEnvironments = [];
  }

  run(args, options) {
    if (args[0] === 'push') this.pushes.push([...args]);
    if (args[0] === 'ls-remote') this.advertisements.push([...args]);
    if (options?.network) this.networkEnvironments.push(this.controlledNetworkEnvironment());
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
    assert.equal(args.includes('--atomic'), false);
    assert.equal(leases.length, 1);
    const refspecs = args.slice(remoteIndex + 1);
    assert.equal(refspecs.length, 1);
    for (const refspec of refspecs) {
      const [source, destination, extra] = refspec.split(':');
      assert.match(source, /^[0-9a-f]{40}$/);
      assert.ok(allowed.has(destination));
      assert.equal(extra, undefined);
      assert.ok(leases.some((lease) => lease.startsWith(`--force-with-lease=${destination}:`)));
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

function runHumanEditedRunSelector({ after, before, head, conclusion }) {
  return spawnSync(
    'jq',
    [
      '-ce',
      '--argjson',
      'before',
      JSON.stringify([before]),
      '--arg',
      'head',
      head,
      '--arg',
      'conclusion',
      conclusion,
      HUMAN_EDITED_RUN_SELECTOR,
    ],
    { encoding: 'utf8', input: JSON.stringify(after) },
  );
}

function runCheckerEvidenceSelector({ evidence, number, head, merge, authorized }) {
  return spawnSync(
    'jq',
    [
      '-e',
      '--argjson',
      'number',
      String(number),
      '--arg',
      'head',
      head,
      '--arg',
      'merge',
      merge,
      '--arg',
      'authorized',
      authorized,
      CHECKER_EVIDENCE_SELECTOR,
    ],
    { encoding: 'utf8', input: JSON.stringify(evidence) },
  );
}

function runPolicySelector(policy, selector, head) {
  return spawnSync('jq', ['-e', '--arg', 'head', head, selector], {
    encoding: 'utf8',
    input: JSON.stringify(policy),
  });
}

function runRequiredContextCheckSelector(checkRuns, { head, context, appId }) {
  return spawnSync(
    'jq',
    [
      '-ce',
      '--arg',
      'head',
      head,
      '--arg',
      'context',
      context,
      '--argjson',
      'app_id',
      String(appId),
      REQUIRED_CONTEXT_CHECK_SELECTOR,
    ],
    { encoding: 'utf8', input: JSON.stringify(checkRuns) },
  );
}

const EXPECTED_STATE_WORKFLOW = {
  name: 'Calibrate current required-check state',
  on: {
    workflow_dispatch: {
      inputs: {
        mode: {
          description: 'Fixed required-check state transition',
          required: true,
          type: 'choice',
          options: ['setup', 'advance-head'],
        },
      },
    },
  },
  permissions: { contents: 'write' },
  concurrency: { group: 'calibration-g1-required-check-current-state', 'cancel-in-progress': false },
  jobs: {
    'maintain-state': {
      name: 'Maintain current required-check calibration state',
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
          with: { 'fetch-depth': 0, 'persist-credentials': false, ref: '${{ github.sha }}' },
        },
        {
          name: 'Maintain the fixed required-check graph',
          run: 'node scripts/calibrate-required-check-state.mjs --mode "$MODE"',
          env: { MODE: '${{ inputs.mode }}', GITHUB_TOKEN: '${{ github.token }}' },
        },
      ],
    },
  },
};

const EXPECTED_CHECK_WORKFLOW = {
  name: 'Required check calibration',
  on: {
    pull_request: {
      branches: ['calibration/g1/required-check-current/base'],
      types: ['opened', 'reopened', 'edited'],
    },
  },
  permissions: { contents: 'read' },
  concurrency: {
    group:
      'calibration-g1-required-check-current-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}',
    'cancel-in-progress': false,
  },
  jobs: {
    'current-head-authorization': {
      name: 'Required calibration head',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5,
      steps: [
        {
          name: 'Check out the exact trusted calibration base',
          uses: 'actions/checkout@v7',
          with: {
            'fetch-depth': 1,
            'persist-credentials': false,
            ref: '${{ github.event.pull_request.base.sha }}',
          },
        },
        {
          name: 'Require the exact current PR-body-authorized head',
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

test('setup creates only the deterministic four-ref graph and preserves all retained evidence', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const first = runStateCalibration({ mode: 'setup', git, source: f.source });
    assert.equal(first.state.head, first.graph.a);
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
      `${V1_NAMESPACE}/base`,
      `${V1_NAMESPACE}/a`,
      `${V1_NAMESPACE}/b`,
      `${V1_NAMESPACE}/head`,
      `${V2_NAMESPACE}/base`,
      `${V2_NAMESPACE}/a`,
      `${V2_NAMESPACE}/b`,
      `${V2_NAMESPACE}/head`,
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

test('pull-request events prove opened A/A and first edited B/B without a synchronize check', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
    setPullMergeRef(f, 20, setup.graph.a);

    checkout(f, setup.graph.base);
    const aCheck = evaluateEvent(git, pullRequestEvent({
      action: 'opened',
      baseSha: setup.graph.base,
      headSha: setup.graph.a,
    }));
    assert.equal(aCheck.authorized, true);
    assert.equal(aCheck.reason, 'pr-body-authorizes-current-head');
    assert.equal(aCheck.remoteBaseSha, setup.graph.base);
    assert.equal(aCheck.remoteHeadSha, setup.graph.a);
    assert.equal(aCheck.remoteMergeSha, setup.graph.a);

    checkoutMain(f);
    const advanced = runStateCalibration({ mode: 'advance-head', git, source: f.source });
    assert.equal(advanced.state.head, setup.graph.b);

    checkout(f, setup.graph.base);
    assert.throws(
      () => evaluateEvent(git, pullRequestEvent({
        action: 'edited',
        baseSha: setup.graph.base,
        headSha: setup.graph.a,
        authorizedSha: setup.graph.a,
        before: setup.graph.b,
      })),
      /Event head SHA is not the current remote calibration head/,
    );

    setPullMergeRef(f, 20, setup.graph.b);
    assert.throws(
      () => evaluateEvent(git, pullRequestEvent({
        action: 'synchronize',
        baseSha: setup.graph.base,
        headSha: setup.graph.b,
        authorizedSha: setup.graph.a,
      })),
      /Unsupported pull request action/,
    );

    const currentB = evaluateEvent(git, pullRequestEvent({
      action: 'edited',
      baseSha: setup.graph.base,
      headSha: setup.graph.b,
      authorizedSha: setup.graph.b,
      before: setup.graph.a,
    }));
    assert.equal(currentB.authorized, true);
    assert.equal(currentB.reason, 'pr-body-authorizes-current-head');
    assert.equal(currentB.remoteBaseSha, setup.graph.base);
    assert.equal(currentB.remoteHeadSha, setup.graph.b);
    assert.equal(currentB.remoteMergeSha, setup.graph.b);
  } finally {
    f.cleanup();
  }
});

test('setup and advance reruns converge without rewrites or an approval write path', () => {
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
    const setupRerun = runStateCalibration({ mode: 'setup', git, source: f.source });
    assert.deepEqual(setupRerun.state, { head: setup.graph.b });
    assert.equal(git.pushes.length, advancePushes);
    assert.throws(
      () => runStateCalibration({ mode: 'approve-head', git, source: f.source }),
      /Unsupported required-check calibration mode/,
    );
    assert.throws(() => calibrationRef('approved'), /Unsupported required-check calibration role/);
    assert.equal(git.pushes.length, advancePushes);
    assertSafePushes(git.pushes);
  } finally {
    f.cleanup();
  }
});

test('PR-body authorization rejects absent, duplicate, malformed, and arbitrary SHA lines', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
    setPullMergeRef(f, 20, setup.graph.a);
    checkout(f, setup.graph.base);
    for (const body of [
      '',
      'No authorization',
      'Authorized-Head-SHA:',
      `Authorized-Head-SHA: ${'A'.repeat(40)}`,
      `Authorized-Head-SHA: ${'1'.repeat(39)}`,
      `Authorized-Head-SHA: ${setup.graph.a}\nAuthorized-Head-SHA: ${setup.graph.a}`,
      ` Authorized-Head-SHA: ${setup.graph.a}`,
      `Authorized-Head-SHA: ${setup.graph.a}\n - Authorized-Head-SHA: ${setup.graph.a}`,
    ]) {
      assert.throws(
        () => evaluateEvent(git, pullRequestEvent({
          action: 'opened',
          baseSha: setup.graph.base,
          headSha: setup.graph.a,
          body,
        })),
        /Authorized-Head-SHA/,
      );
    }
    assert.equal(parseAuthorizedHead(`Authorized-Head-SHA: ${setup.graph.a}`), setup.graph.a);
    const arbitrary = evaluateEvent(git, pullRequestEvent({
      action: 'opened',
      baseSha: setup.graph.base,
      headSha: setup.graph.a,
      authorizedSha: '1'.repeat(40),
    }));
    assert.equal(arbitrary.authorized, false);
    assert.equal(arbitrary.reason, 'pr-body-does-not-authorize-current-head');
    assert.equal(git.pushes.length, 4);
  } finally {
    f.cleanup();
  }
});

test('source drift fails closed without a state write', () => {
  const f = fixture();
  try {
    const git = new RecordingGit(gitOptions(f));
    runStateCalibration({ mode: 'setup', git, source: f.source });
    const pushes = git.pushes.length;
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

test('every write helper rejects refs outside the exact four-name set before Git runs', () => {
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
  assert.throws(() => calibrationRef('approved'), /Unsupported/);
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
        () => evaluateEvent(hostile, pullRequestEvent({
          action: 'opened',
          baseSha: f.source,
          headSha: f.source,
        })),
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
      ['http.https://github.com/.extraheader', 'AUTHORIZATION: basic inherited'],
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
        () => evaluateEvent(checkGit, pullRequestEvent({
          action: 'opened',
          baseSha: f.source,
          headSha: f.source,
        })),
        /Unsafe repository Git config/,
        key,
      );
      assert.equal(checkGit.advertisements.length, 0, key);
      command(f.runner, ['config', '--unset-all', key]);
    }
    assert.equal(existsSync(join(f.root, 'credential-helper-ran')), false);

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
      setPullMergeRef(f, 20, setup.graph.a);
      checkout(f, setup.graph.base);
      const checkGit = new RecordingGit(gitOptions(f));
      assert.equal(
        evaluateEvent(checkGit, pullRequestEvent({
          action: 'opened',
          baseSha: setup.graph.base,
          headSha: setup.graph.a,
        })).authorized,
        true,
      );
      assert.equal(checkGit.advertisements.length, 1);
      assert.deepEqual(checkGit.networkEnvironments, [{}]);
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
          () => evaluateEvent(checkGit, pullRequestEvent({
            action: 'opened',
            baseSha: f.source,
            headSha: f.source,
          })),
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

test('live state mutation requires GITHUB_TOKEN before any advertisement or write', () => {
  const f = fixture();
  try {
    const git = new RecordingGit({
      ...gitOptions(f),
      liveNetworkWrite: true,
      token: undefined,
    });
    assert.throws(
      () => runStateCalibration({ mode: 'setup', git, source: f.source }),
      /GITHUB_TOKEN is required for live calibration writes/,
    );
    assert.equal(git.advertisements.length, 0);
    assert.equal(git.pushes.length, 0);
    assert.equal(remoteRef(f, calibrationRef('base')), null);
  } finally {
    f.cleanup();
  }
});

test('checkout-v7 includeIf remains rejected, then controlled live auth succeeds without token leakage', () => {
  const f = fixture();
  const includePath = join(f.root, 'checkout-v7-auth.config');
  const includeKey = 'includeIf.gitdir:/home/runner/work/lab-01/lab-01/.git.path';
  const token = 'test-token-that-must-not-leak';
  try {
    writeFileSync(
      includePath,
      '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic inherited\n',
    );
    command(f.runner, ['config', includeKey, includePath]);
    const rejected = new RecordingGit({
      ...gitOptions(f),
      liveNetworkWrite: true,
      token,
    });
    assert.throws(
      () => runStateCalibration({ mode: 'setup', git: rejected, source: f.source }),
      /Unsafe repository Git config: includeif\.gitdir:.*\.git\.path/,
    );
    assert.equal(rejected.advertisements.length, 0);
    assert.equal(rejected.pushes.length, 0);
    assert.equal(remoteRef(f, calibrationRef('base')), null);
    command(f.runner, ['config', '--unset-all', includeKey]);

    command(f.runner, ['config', 'push.followTags', 'true']);
    command(f.runner, ['tag', '-a', 'must-not-follow', f.source, '-m', 'must not follow']);
    const git = new RecordingGit({
      ...gitOptions(f),
      liveNetworkWrite: true,
      token,
    });
    const result = runStateCalibration({ mode: 'setup', git, source: f.source });
    assertSafePushes(git.pushes);
    assert.equal(remoteRef(f, 'refs/tags/must-not-follow'), null);
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    assert.deepEqual(git.controlledNetworkEnvironment(), {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
    });
    assert.ok(git.networkEnvironments.length > 0);
    for (const environment of git.networkEnvironments) {
      assert.deepEqual(environment, git.controlledNetworkEnvironment());
    }
    setPullMergeRef(f, 20, result.graph.a);
    checkout(f, result.graph.base);
    const readOnly = new RecordingGit({
      ...gitOptions(f),
      liveNetworkWrite: true,
      token: undefined,
    });
    assert.equal(
      evaluateEvent(readOnly, pullRequestEvent({
        action: 'opened',
        baseSha: result.graph.base,
        headSha: result.graph.a,
      })).authorized,
      true,
    );
    assert.equal(readOnly.advertisements.length, 1);
    assert.ok(readOnly.networkEnvironments.every((environment) => Object.keys(environment).length === 0));
    checkoutMain(f);
    assert.equal(git.token, null);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(git.pushes), new RegExp(`${token}|${encoded}`));
    let failure;
    try {
      git.run(['definitely-not-a-git-command'], { network: true, requireAuthentication: true });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.doesNotMatch(failure.message, new RegExp(`${token}|${encoded}|AUTHORIZATION`, 'i'));
    assert.doesNotMatch(
      command(f.runner, ['config', '--local', '--name-only', '--get-regexp', '.*']),
      /^(?:http|include)/m,
    );
  } finally {
    f.cleanup();
  }
});

test('event payload, action, identity, refs, and trusted base checkout all fail closed', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git, source: f.source });
    setPullMergeRef(f, 20, setup.graph.a);
    checkout(f, setup.graph.base);
    const valid = pullRequestEvent({
      action: 'opened',
      baseSha: setup.graph.base,
      headSha: setup.graph.a,
    });

    const mutations = [
      ['wrong event repository', (event) => { event.repository.full_name = 'attacker/fork'; }],
      ['wrong base repository', (event) => { event.pull_request.base.repo.full_name = 'attacker/fork'; }],
      ['fork head', (event) => { event.pull_request.head.repo.full_name = 'attacker/fork'; }],
      ['wrong base ref', (event) => { event.pull_request.base.ref = 'main'; }],
      ['wrong head ref', (event) => { event.pull_request.head.ref = 'feature'; }],
      ['draft', (event) => { event.pull_request.draft = true; }],
      ['merged', (event) => { event.pull_request.merged = true; event.pull_request.merged_at = '2026-07-15T18:00:00Z'; }],
      ['closed', (event) => { event.pull_request.state = 'closed'; }],
      ['mismatched number', (event) => { event.pull_request.number = 21; }],
      ['protected release PR', (event) => { event.number = 12; event.pull_request.number = 12; }],
      ['protected recovery PR', (event) => { event.number = 16; event.pull_request.number = 16; }],
      ['protected failed calibration PR', (event) => { event.number = 19; event.pull_request.number = 19; }],
      ['protected v2 calibration PR', (event) => { event.number = 21; event.pull_request.number = 21; }],
      ['uppercase head SHA', (event) => { event.pull_request.head.sha = 'A'.repeat(40); }],
    ];
    for (const [description, mutate] of mutations) {
      const event = structuredClone(valid);
      mutate(event);
      assert.throws(() => evaluateEvent(git, event), undefined, description);
    }
    assert.throws(() => evaluateEvent(git, valid, { repository: 'attacker/fork' }), /GITHUB_REPOSITORY/);
    assert.throws(() => evaluateEvent(git, valid, { eventName: 'workflow_dispatch' }), /GITHUB_EVENT_NAME/);
    assert.throws(() => evaluateEvent(git, valid, { githubRef: 'refs/heads/main' }), /GITHUB_REF/);
    assert.throws(() => evaluateEvent(git, valid, { baseRef: 'main' }), /GITHUB_BASE_REF/);
    assert.throws(() => evaluateEvent(git, valid, { headRef: 'feature' }), /GITHUB_HEAD_REF/);

    const badSynchronize = pullRequestEvent({
      action: 'synchronize',
      baseSha: setup.graph.base,
      headSha: setup.graph.b,
      before: setup.graph.b,
    });
    assert.throws(() => evaluateEvent(git, badSynchronize), /Unsupported pull request action/);
    const badEdited = pullRequestEvent({
      action: 'edited',
      baseSha: setup.graph.base,
      headSha: setup.graph.a,
      before: setup.graph.a,
    });
    badEdited.changes = { title: { from: 'old' } };
    assert.throws(() => evaluateEvent(git, badEdited), /Edited event body change/);

    checkout(f, setup.graph.a);
    assert.throws(() => evaluateEvent(git, valid), /not trusted event base SHA/);
  } finally {
    f.cleanup();
  }
});

test('one strict public advertisement binds current base, head, merge ref, and GITHUB_SHA', () => {
  const f = fixture();
  try {
    const setupGit = new Git(gitOptions(f));
    const setup = runStateCalibration({ mode: 'setup', git: setupGit, source: f.source });
    setPullMergeRef(f, 20, setup.graph.a);
    checkout(f, setup.graph.base);
    const event = pullRequestEvent({
      action: 'opened',
      baseSha: setup.graph.base,
      headSha: setup.graph.a,
    });
    const git = new RecordingGit(gitOptions(f));
    assert.equal(evaluateEvent(git, event).authorized, true);
    assert.deepEqual(git.advertisements, [[
      'ls-remote',
      '--refs',
      'origin',
      calibrationRef('base'),
      calibrationRef('head'),
      'refs/pull/20/merge',
    ]]);
    assert.deepEqual(git.networkEnvironments, [{}]);

    assert.throws(
      () => evaluateEvent(git, event, { githubSha: 'f'.repeat(40) }),
      /GITHUB_SHA is not the current remote pull request merge ref/,
    );

    updateRemoteRef(f, calibrationRef('base'), f.source);
    assert.throws(
      () => evaluateEvent(git, event),
      /Event base SHA is not the current remote calibration base/,
    );
    updateRemoteRef(f, calibrationRef('base'), setup.graph.base);

    updateRemoteRef(f, 'refs/pull/20/merge', f.source);
    assert.throws(
      () => evaluateEvent(git, event),
      /GITHUB_SHA is not the current remote pull request merge ref/,
    );
    deleteRemoteRef(f, 'refs/pull/20/merge');
    assert.throws(
      () => evaluateEvent(git, event),
      /Required remote ref is absent: refs\/pull\/20\/merge/,
    );
    setPullMergeRef(f, 20, setup.graph.a);

    class MalformedAdvertisementGit extends Git {
      text(args, options) {
        if (args[0] === 'ls-remote') {
          return `${setup.graph.base}\t${calibrationRef('base')}\textra-field`;
        }
        return super.text(args, options);
      }
    }
    assert.throws(
      () => evaluateEvent(new MalformedAdvertisementGit(gitOptions(f)), event),
      /Malformed remote advertisement record/,
    );
  } finally {
    f.cleanup();
  }
});

test('GITHUB_EVENT_PATH accepts one bounded regular JSON file and rejects path attacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-required-check-event-'));
  const eventPath = join(root, 'event.json');
  const symlinkPath = join(root, 'event-link.json');
  const fifoPath = join(root, 'event.fifo');
  try {
    const event = { action: 'opened', number: 20 };
    writeFileSync(eventPath, JSON.stringify(event));
    assert.deepEqual(readPullRequestEvent(eventPath), event);
    symlinkSync(eventPath, symlinkPath);
    assert.throws(() => readPullRequestEvent(symlinkPath), /non-symlink/);
    assert.throws(() => readPullRequestEvent(root), /regular non-symlink/);
    writeFileSync(eventPath, '{not-json');
    assert.throws(() => readPullRequestEvent(eventPath), /not valid JSON/);
    writeFileSync(eventPath, 'x'.repeat(1024 * 1024 + 1));
    assert.throws(() => readPullRequestEvent(eventPath), /unsafe size/);
    assert.throws(() => readPullRequestEvent(''), /GITHUB_EVENT_PATH/);

    execFileSync('mkfifo', [fifoPath]);
    const checkerUrl = new URL('../scripts/check-required-calibration-head.mjs', import.meta.url).href;
    const probeSource =
      `import { readPullRequestEvent } from ${JSON.stringify(checkerUrl)};\n` +
      'readPullRequestEvent(process.argv[1]);\n';
    const started = Date.now();
    const fifoProbe = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', probeSource, fifoPath],
      { encoding: 'utf8', timeout: 1000 },
    );
    assert.equal(fifoProbe.status, 1);
    assert.equal(fifoProbe.signal, null);
    assert.match(fifoProbe.stderr, /regular non-symlink file/);
    assert.ok(Date.now() - started < 750, 'FIFO rejection must not wait for a writer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workflows have exact state dispatch, PR trigger, permissions, and one stable check context', () => {
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
    stateYaml.replace('persist-credentials: false', 'persist-credentials: true'),
    stateYaml.replace('GITHUB_TOKEN: ${{ github.token }}', 'GITHUB_TOKEN: ${{ secrets.CALIBRATION_TOKEN }}'),
    stateYaml.replace('fetch-depth: 0', 'fetch-depth: 1'),
    stateYaml.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    stateYaml.replace('node scripts/calibrate-required-check-state.mjs --mode "$MODE"', 'git push origin HEAD:main'),
  ];
  for (const mutant of stateMutants) {
    assert.throws(() => assertExactWorkflows(mutant, checkYaml));
  }

  const checkMutants = [
    checkYaml.replace('  pull_request:', '  pull_request:\n  push:'),
    checkYaml.replace('calibration/g1/required-check-current/base', 'main'),
    checkYaml.replace('      - edited', '      - closed'),
    checkYaml.replace('      - reopened', '      - synchronize\n      - reopened'),
    checkYaml.replace('      - reopened', ''),
    checkYaml.replace('permissions:\n  contents: read', 'permissions: { contents: write }'),
    checkYaml.replace('    runs-on: ubuntu-latest', '    permissions: { statuses: write }\n    runs-on: ubuntu-latest'),
    checkYaml.replace(
      'jobs:\n',
      'jobs:\n  injected: { runs-on: ubuntu-latest, steps: [{ run: "curl https://api.github.com" }] }\n',
    ),
    checkYaml.replace(
      '      - name: Require the exact current PR-body-authorized head',
      '      - { name: Unsafe merge, run: "gh pr merge --merge" }\n' +
        '      - name: Require the exact current PR-body-authorized head',
    ),
    checkYaml.replace('persist-credentials: false', 'persist-credentials: true'),
    checkYaml.replace('${{ github.event.pull_request.base.sha }}', '${{ github.event.pull_request.head.sha }}'),
    checkYaml.replace('fetch-depth: 1', 'fetch-depth: 0'),
    checkYaml.replace('node scripts/check-required-calibration-head.mjs', 'curl https://api.github.com'),
    checkYaml.replace('Required calibration head', 'Different context'),
    checkYaml.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
  ];
  for (const mutant of checkMutants) {
    assert.throws(() => assertExactWorkflows(stateYaml, mutant));
  }
});

test('v3 jq evidence requires no B context before edit and one human B/B success after edit', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  const wrongHead = 'd'.repeat(40);
  const context = 'Required calibration head';
  const appId = 15368;
  assert.notEqual(b, merge);

  const oldRun = {
    id: 100,
    event: 'pull_request',
    actor: { login: 'ndelangen' },
    path: '.github/workflows/calibrate-required-check.yml',
    head_branch: 'calibration/g1/required-check-current/head',
    head_sha: a,
    status: 'completed',
    conclusion: 'success',
  };
  const successfulRun = { ...oldRun, id: 101, head_sha: b };
  const before = { workflow_runs: [oldRun] };
  const selectedSuccess = runHumanEditedRunSelector({
    before,
    after: { workflow_runs: [oldRun, successfulRun] },
    head: b,
    conclusion: 'success',
  });
  assert.equal(selectedSuccess.status, 0, selectedSuccess.stderr);
  assert.equal(JSON.parse(selectedSuccess.stdout).id, successfulRun.id);

  const rejectedRuns = [
    { name: 'merge SHA used as REST head', run: { ...successfulRun, head_sha: merge } },
    { name: 'wrong current B', run: { ...successfulRun, head_sha: wrongHead } },
    { name: 'wrong actor', run: { ...successfulRun, actor: { login: 'github-actions[bot]' } } },
    { name: 'wrong event', run: { ...successfulRun, event: 'workflow_dispatch' } },
    { name: 'wrong workflow', run: { ...successfulRun, path: '.github/workflows/other.yml' } },
    { name: 'wrong conclusion', run: { ...successfulRun, conclusion: 'failure' } },
    { name: 'incomplete run', run: { ...successfulRun, status: 'in_progress', conclusion: null } },
  ];
  for (const { name, run } of rejectedRuns) {
    const result = runHumanEditedRunSelector({
      before,
      after: { workflow_runs: [oldRun, run] },
      head: b,
      conclusion: 'success',
    });
    assert.notEqual(result.status, 0, name);
  }
  assert.notEqual(
    runHumanEditedRunSelector({
      before,
      after: { workflow_runs: [oldRun, successfulRun] },
      head: wrongHead,
      conclusion: 'success',
    }).status,
    0,
  );

  const preexistingOnly = runHumanEditedRunSelector({
    before: { workflow_runs: [successfulRun] },
    after: { workflow_runs: [successfulRun] },
    head: b,
    conclusion: 'success',
  });
  assert.notEqual(preexistingOnly.status, 0);

  const extraMatch = runHumanEditedRunSelector({
    before,
    after: { workflow_runs: [oldRun, successfulRun, { ...successfulRun, id: 103 }] },
    head: b,
    conclusion: 'success',
  });
  assert.notEqual(extraMatch.status, 0);

  const checkerEvidence = {
    action: 'edited',
    number: 20,
    headSha: b,
    remoteHeadSha: b,
    remoteMergeSha: merge,
    authorizedSha: b,
  };
  const selectedGreenCheckerEvidence = runCheckerEvidenceSelector({
    evidence: checkerEvidence,
    number: 20,
    head: b,
    merge,
    authorized: b,
  });
  assert.equal(selectedGreenCheckerEvidence.status, 0, selectedGreenCheckerEvidence.stderr);
  assert.notEqual(
    runCheckerEvidenceSelector({
      evidence: { ...checkerEvidence, remoteMergeSha: b },
      number: 20,
      head: b,
      merge,
      authorized: b,
    }).status,
    0,
  );

  const checksBeforeEdit = [
    {
      check_runs: [
        { head_sha: a, name: context, app: { id: appId }, conclusion: 'success' },
        { head_sha: b, name: 'Unrelated check', app: { id: appId }, conclusion: 'success' },
      ],
    },
  ];
  const selectedBeforeChecks = runRequiredContextCheckSelector(checksBeforeEdit, {
    head: b,
    context,
    appId,
  });
  assert.equal(selectedBeforeChecks.status, 0, selectedBeforeChecks.stderr);
  assert.deepEqual(JSON.parse(selectedBeforeChecks.stdout), []);

  const bSuccessCheck = {
    head_sha: b,
    name: context,
    app: { id: appId },
    status: 'completed',
    conclusion: 'success',
  };
  const selectedAfterChecks = runRequiredContextCheckSelector(
    [{ check_runs: [...checksBeforeEdit[0].check_runs, bSuccessCheck] }],
    { head: b, context, appId },
  );
  assert.equal(selectedAfterChecks.status, 0, selectedAfterChecks.stderr);
  assert.deepEqual(JSON.parse(selectedAfterChecks.stdout), [bSuccessCheck]);
  const poisonedBeforeEdit = runRequiredContextCheckSelector(
    [{ check_runs: [...checksBeforeEdit[0].check_runs, { ...bSuccessCheck, conclusion: 'failure' }] }],
    { head: b, context, appId },
  );
  assert.equal(JSON.parse(poisonedBeforeEdit.stdout).length, 1);

  const beforeEditPolicy = {
    repository: {
      pullRequest: {
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        headRefOid: b,
        commits: {
          nodes: [{ commit: { statusCheckRollup: null } }],
        },
      },
    },
  };
  const selectedBeforePolicy = runPolicySelector(
    beforeEditPolicy,
    B_BEFORE_EDIT_POLICY_SELECTOR,
    b,
  );
  assert.equal(selectedBeforePolicy.status, 0, selectedBeforePolicy.stderr);
  const poisonedPolicy = structuredClone(beforeEditPolicy);
  poisonedPolicy.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = {
    state: 'FAILURE',
  };
  assert.notEqual(runPolicySelector(poisonedPolicy, B_BEFORE_EDIT_POLICY_SELECTOR, b).status, 0);

  const afterEditPolicy = structuredClone(beforeEditPolicy);
  afterEditPolicy.repository.pullRequest.mergeStateStatus = 'CLEAN';
  afterEditPolicy.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = {
    state: 'SUCCESS',
  };
  const selectedAfterPolicy = runPolicySelector(
    afterEditPolicy,
    B_AFTER_EDIT_POLICY_SELECTOR,
    b,
  );
  assert.equal(selectedAfterPolicy.status, 0, selectedAfterPolicy.stderr);
  const aggregatedFailurePolicy = structuredClone(afterEditPolicy);
  aggregatedFailurePolicy.repository.pullRequest.mergeStateStatus = 'UNSTABLE';
  aggregatedFailurePolicy.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = {
    state: 'FAILURE',
  };
  assert.notEqual(
    runPolicySelector(aggregatedFailurePolicy, B_AFTER_EDIT_POLICY_SELECTOR, b).status,
    0,
  );
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
      /api\.github\.com|\bgh\s+api\b|\bgh\s+pr\b|\bcurl\b|\/branches\/.*\/protection/i,
    );
    assert.doesNotMatch(script, /\bfetch\s*\(|https?\.request\s*\(|spawnSync\((?!'git')/);
  }
  assert.equal(stateScript.match(/spawnSync\('git'/g)?.length, 1);
  assert.equal(checkScript.match(/spawnSync\(/g), null);
  assert.match(stateScript, /key !== 'GITHUB_TOKEN'/);
  assert.doesNotMatch(stateScript, /push.*GITHUB_TOKEN|AUTHORIZATION.*args/);
  assert.doesNotMatch(stateScript, /approved|approve-head/i);
  assert.doesNotMatch(checkScript, /approved|approve-head/i);
  assert.match(docs, /does not claim v3 proof\s+until the complete live sequence/);
  assert.match(docs, /calibration\/g1\/required-check-current\/base/);
  assert.match(docs, /calibration\/g1\/required-check-current\/head/);
  assert.match(docs, /calibration\/g1\/required-check-pr\/\{base,a,b,head\}/);
  assert.match(docs, /There is deliberately no `synchronize` trigger/);
  assert.match(docs, /triggers only for\s+`pull_request` actions `opened`, `reopened`, and `edited`/s);
  assert.doesNotMatch(docs, /actions `opened`, `synchronize`/);
  assert.match(checkScript, /PROTECTED_PULL_REQUESTS = new Set\(\[12, 16, 19, 21\]\)/);
  assert.match(checkScript, /PULL_REQUEST_ACTIONS = \['opened', 'reopened', 'edited'\]/);
  assert.match(checkScript, /constants\.O_NONBLOCK/);
  assert.match(docs, /Authorized-Head-SHA: <lowercase 40-hex current head SHA>/);
  assert.match(docs, /persist-credentials: false/);
  assert.match(docs, /GIT_CONFIG_COUNT/);
  assert.match(docs, /one credential-free public\s+`git ls-remote --refs`/s);
  assert.match(docs, /refs\/pull\/<PR>\/merge/);
  assert.match(docs, /GITHUB_SHA.*current advertised pull merge ref/s);
  assert.match(docs, /statusCheckRollup/);
  assert.match(docs, /mergeStateStatus/);
  assert.match(docs, /every five seconds for at most five minutes/);
  assert.match(docs, /number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null/);
  assert.match(docs, /Never merge, close, or draft it/);
  assert.match(docs, /actions\/runs\/29437465131/);
  assert.match(docs, /actions\/runs\/29438908229/);
  assert.match(docs, /actions\/runs\/29439025160/);
  assert.match(docs, /pull\/21/);
  assert.match(docs, /actions\/runs\/29443682944/);
  assert.match(docs, /actions\/runs\/29443714934/);
  assert.match(docs, /actions\/runs\/29444330224/);
  assert.match(docs, /fc7876e24d3e55e326862c9495481eb3bc07f049/);
  assert.match(docs, /07a51d4dda009d2e60c3390f4a3e4ea9dd9a75eb/);
  assert.match(docs, /a150bbdfb4f1afd9350020ef717206d59a56678e/);
  assert.match(docs, /final v2 GraphQL state is\s+`mergeStateStatus=UNSTABLE` and `statusCheckRollup\.state=FAILURE`/s);
  assert.match(docs, /same-name failure and\s+success on one SHA aggregate to failure/s);
  assert.match(docs, /not failure hiding/);
  assert.match(docs, /must not be used as a reauthorization phase/);
  const aGreenRow = docs.split('\n').find((line) => line.startsWith('| `a-green`'));
  const bBeforeRow = docs.split('\n').find((line) => line.startsWith('| `b-before-edit`'));
  const bAfterRow = docs.split('\n').find((line) => line.startsWith('| `b-after-edit`'));
  assert.match(aGreenRow, /\(MERGEABLE, CLEAN, SUCCESS\)/);
  assert.match(bBeforeRow, /zero context\/App CheckRuns/);
  assert.match(bBeforeRow, /\(MERGEABLE, BLOCKED, null\)/);
  assert.match(bAfterRow, /exactly one new human `edited` successful/);
  assert.match(bAfterRow, /\(MERGEABLE, CLEAN, SUCCESS\)/);
  assert.match(docs, /select\(length == 0\)/);
  assert.match(docs, /stop\s+and abandon the v3 namespace/);
  assert.match(docs, /do not create an intentional B\/A\s+required run/s);
  assert.equal(docs.match(/--body-file b-after-edit-body\.md/g)?.length, 1);
  assert.match(docs, /\.head_sha == \$head/);
  assert.match(docs, /\.conclusion == "success"/);
  assert.match(docs, /remoteMergeSha.*separately advertised/s);
  assert.match(docs, /Require exactly one exact context\/App match/);
  assert.match(docs, /does not prove fully autonomous dependent\s+dispatch/s);
  assert.match(docs, /must not modify v1 or v2 namespaces/);
  assert.doesNotMatch(docs, /v3 proof (?:is|was) complete|v3 succeeded/i);
  assert.doesNotMatch(docs, /authorized_sha|--authorized-sha/);
});
