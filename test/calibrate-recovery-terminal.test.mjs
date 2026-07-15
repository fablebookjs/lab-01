import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FILE_PATH,
  Git,
  GitHub,
  NAMESPACE,
  PullRequestPostError,
  ROLES,
  assertRecoveryTerminalRef,
  classifyPullRequestResponse,
  createProposalCommit,
  createRecoveryGraph,
  parseRemoteAdvertisement,
  proposalMessage,
  proposalPullRequestBody,
  pushWithLease,
  recoveryTerminalRef,
  runRecoveryTerminal,
  verifyProposalCommit,
  verifyProposalHistoryPullRequest,
  verifyProposalPullRequest,
  verifyRecoveryGraph,
  verifyRecoveryPullRequest,
} from '../scripts/calibrate-recovery-terminal.mjs';

const RECOVERY_SYNTHETIC_MERGE_SHA = '9'.repeat(40);
const PROPOSAL_SYNTHETIC_MERGE_SHA = '8'.repeat(40);
const CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA = `${'7'.repeat(39)}a`;

function command(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', ...env },
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-recovery-terminal-test-'));
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
    GIT_AUTHOR_DATE: '2026-07-15T17:00:00Z',
    GIT_COMMITTER_DATE: '2026-07-15T17:00:00Z',
  });
  const source = command(seed, ['rev-parse', 'HEAD']);
  command(seed, ['remote', 'add', 'origin', remote]);
  command(seed, [
    'push',
    'origin',
    'main',
    `${source}:refs/heads/releases/v1.0`,
    `${source}:refs/heads/staged/v1.0`,
    `${source}:refs/heads/calibration/g1/conflict-recovery/line`,
    `${source}:refs/heads/calibration/g1/required-check-current/head`,
  ]);
  command(seed, ['tag', '-a', 'v1.0.0', source, '-m', 'retained baseline']);
  command(seed, ['push', 'origin', 'refs/tags/v1.0.0']);
  command(root, ['clone', remote, runner]);
  command(runner, ['checkout', 'main']);
  return {
    root,
    remote,
    seed,
    runner,
    source,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function gitOptions(f) {
  return { cwd: f.runner, acceptedRemoteUrls: [f.remote] };
}

function remoteRef(f, ref) {
  const output = command(f.runner, ['ls-remote', '--heads', f.remote, ref]);
  return output ? output.split(/\s+/)[0] : null;
}

function remoteSnapshot(f) {
  return command(f.runner, ['ls-remote', f.remote]).split('\n').filter(Boolean).sort();
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

function recoveryPull(graph, number = 101) {
  return {
    number,
    html_url: `https://github.com/fablebookjs/lab-01/pull/${number}`,
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    merge_commit_sha: RECOVERY_SYNTHETIC_MERGE_SHA,
    title: 'Complete dedicated recovery-terminal calibration',
    body: 'operator body',
    base: {
      ref: 'calibration/g1/recovery-terminal/line',
      sha: graph.source,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
    head: {
      ref: 'calibration/g1/recovery-terminal/recovery',
      sha: graph.recovery,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
  };
}

function proposalPull(state, input, number = 102) {
  return {
    number,
    html_url: `https://github.com/fablebookjs/lab-01/pull/${number}`,
    state: 'open',
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: PROPOSAL_SYNTHETIC_MERGE_SHA,
    title: input.title,
    body: input.body,
    base: {
      ref: input.base,
      sha: state.line,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
    head: {
      ref: input.head,
      sha: state.proposal,
      repo: { full_name: 'fablebookjs/lab-01' },
    },
  };
}

class FakeGitHub {
  constructor(graph, recovery = null) {
    this.graph = graph;
    this.recovery = recovery;
    this.proposals = [];
    this.listCalls = [];
    this.getCalls = [];
    this.createCalls = [];
    this.nextProposalNumber = 102;
  }

  async listPullRequestHistoryPage(filter) {
    this.listCalls.push({ ...filter });
    if (filter.page !== 1) return [];
    if (filter.head.endsWith('/recovery')) return this.recovery ? [structuredClone(this.recovery)] : [];
    if (filter.head.endsWith('/proposal')) return structuredClone(this.proposals);
    throw new Error(`unexpected query ${filter.head}`);
  }

  async createPullRequest(input) {
    this.createCalls.push(structuredClone(input));
    const state = {
      line: this.recovery.merge_commit_sha,
      proposal: remoteProposalFromInput(this, input),
    };
    const pull = proposalPull(state, input, this.nextProposalNumber);
    this.nextProposalNumber += 1;
    this.proposals.push(pull);
    return structuredClone(pull);
  }

  async getPullRequest(number) {
    this.getCalls.push(number);
    if (!this.recovery || this.recovery.number !== number) throw new Error(`unknown recovery PR ${number}`);
    return structuredClone(this.recovery);
  }

  async waitForRetry() {}
}

function remoteProposalFromInput(github) {
  return github.proposalSha;
}

function normalMerge(f, graph, pr) {
  const merge = command(f.runner, [
    'commit-tree',
    `${graph.recovery}^{tree}`,
    '-p',
    graph.source,
    '-p',
    graph.recovery,
    '-m',
    'Merge dedicated recovery-terminal calibration',
  ], {
    GIT_AUTHOR_NAME: 'GitHub',
    GIT_AUTHOR_EMAIL: 'noreply@github.com',
    GIT_AUTHOR_DATE: '2026-07-15T18:30:00Z',
    GIT_COMMITTER_NAME: 'GitHub',
    GIT_COMMITTER_EMAIL: 'noreply@github.com',
    GIT_COMMITTER_DATE: '2026-07-15T18:30:00Z',
  });
  command(f.runner, [
    'push',
    '--force-with-lease=refs/heads/calibration/g1/recovery-terminal/line:' + graph.source,
    f.remote,
    `${merge}:refs/heads/calibration/g1/recovery-terminal/line`,
  ]);
  Object.assign(pr, {
    state: 'closed',
    merged: true,
    merged_at: '2026-07-15T18:31:00Z',
    merge_commit_sha: merge,
  });
  return merge;
}

async function prepared({ merge = false } = {}) {
  const f = fixture();
  const git = new RecordingGit(gitOptions(f));
  const setup = await runRecoveryTerminal({ mode: 'setup', git, source: f.source });
  const pr = recoveryPull(setup.graph);
  const github = new FakeGitHub(setup.graph, pr);
  let line = null;
  if (merge) line = normalMerge(f, setup.graph, pr);
  return { f, git, setup, pr, github, line };
}

test('setup creates only the exact five-role namespace inputs and is byte-for-byte reusable', async () => {
  const f = fixture();
  try {
    const before = remoteSnapshot(f);
    const git = new RecordingGit(gitOptions(f));
    const first = await runRecoveryTerminal({ mode: 'setup', git, source: f.source });
    assert.equal(first.outcome, 'recovery-ready-for-operator-pr');
    assert.deepEqual(ROLES, ['source', 'line', 'recovery', 'proposal', 'pr-attempt']);
    assert.deepEqual(parents(f, first.graph.recovery), [f.source]);
    assert.equal(command(f.runner, ['show', `${first.graph.recovery}:${FILE_PATH}`]), 'dedicated recovery-terminal completion');
    assert.equal(remoteRef(f, recoveryTerminalRef('source')), f.source);
    assert.equal(remoteRef(f, recoveryTerminalRef('line')), f.source);
    assert.equal(remoteRef(f, recoveryTerminalRef('recovery')), first.graph.recovery);
    assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), first.graph.recovery);
    assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), null);
    const after = remoteSnapshot(f);
    assert.deepEqual(
      after.filter((line) => !line.includes(`${NAMESPACE}/`)),
      before,
    );
    const pushes = git.pushes.length;
    const second = await runRecoveryTerminal({ mode: 'setup', git, source: f.source });
    assert.deepEqual(second.graph, first.graph);
    assert.equal(git.pushes.length, pushes);
    for (const args of git.pushes) {
      assert.ok(args.includes('--no-follow-tags'));
      assert.ok(args.includes('--porcelain'));
      assert.ok(args.some((arg) => arg.startsWith('--force-with-lease=')));
      assert.equal(args.at(-1).split(':')[1].startsWith(`${NAMESPACE}/`), true);
    }
  } finally {
    f.cleanup();
  }
});

test('recovery and proposal commits have exact graph, tree, message, and ref boundaries', () => {
  const f = fixture();
  try {
    const git = new Git(gitOptions(f));
    const graph = verifyRecoveryGraph(git, createRecoveryGraph(git, f.source));
    command(f.runner, ['push', f.remote, `${graph.source}:${recoveryTerminalRef('line')}`]);
    const merge = normalMerge(f, graph, recoveryPull(graph));
    const state = { line: merge, recovery: graph.recovery };
    const proposal = verifyProposalCommit(git, createProposalCommit(git, state), state);
    assert.deepEqual(parents(f, proposal), [merge]);
    assert.equal(tree(f, proposal), tree(f, merge));
    assert.equal(command(f.runner, ['show', '-s', '--format=%B', proposal]), proposalMessage(state));
    assert.throws(() => recoveryTerminalRef('tag'), /Unsupported recovery-terminal role/);
    assert.throws(() => assertRecoveryTerminalRef('refs/heads/releases/v1.0'), /outside the exact/);
    assert.throws(() => pushWithLease(git, 'refs/tags/v1.0.1', null, proposal), /outside the exact/);
  } finally {
    f.cleanup();
  }
});

test('two open-recovery sweeps suppress before proposal ref, marker, or POST writes', async () => {
  const { f, git, setup, github } = await prepared();
  try {
    const pushes = git.pushes.length;
    const first = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    const second = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(first.outcome, 'blocked-recovery-open');
    assert.equal(second.outcome, 'blocked-recovery-open');
    assert.equal(first.proposal, null);
    assert.equal(second.proposal, null);
    assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), null);
    assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), setup.graph.recovery);
    assert.equal(git.pushes.length, pushes);
    assert.equal(github.createCalls.length, 0);
    assert.ok(github.listCalls.every((call) => call.page === 1 && call.head === 'fablebookjs:calibration/g1/recovery-terminal/recovery'));
  } finally {
    f.cleanup();
  }
});

test('open recovery fails closed if out-of-order state already exposes a proposal or consumed marker', async () => {
  for (const kind of ['proposal', 'marker']) {
    const { f, git, setup, github } = await prepared();
    try {
      const forged = command(f.runner, ['commit-tree', `${f.source}^{tree}`, '-p', f.source, '-m', 'forged early proposal']);
      if (kind === 'proposal') {
        command(f.runner, ['push', f.remote, `${forged}:${recoveryTerminalRef('proposal')}`]);
      } else {
        command(f.runner, ['push', '--force', f.remote, `${forged}:${recoveryTerminalRef('pr-attempt')}`]);
      }
      await assert.rejects(
        runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
        /proposal ref already exists|PR-attempt marker is not exact recovery head|Pre-proposal PR-attempt marker/,
      );
      assert.equal(github.createCalls.length, 0);
      assert.equal(remoteRef(f, recoveryTerminalRef('line')), setup.graph.source);
    } finally {
      f.cleanup();
    }
  }
});

test('exact normal recovery merge creates one empty proposal and draft PR; rerun reuses both', async () => {
  const { f, git, setup, pr, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    const first = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(first.outcome, 'proposal-created');
    assert.equal(first.recoveredLine, line);
    assert.deepEqual(parents(f, line), [f.source, setup.graph.recovery]);
    assert.equal(tree(f, line), tree(f, setup.graph.recovery));
    assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), first.proposal.sha);
    assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), first.proposal.sha);
    assert.deepEqual(parents(f, first.proposal.sha), [line]);
    assert.equal(tree(f, first.proposal.sha), tree(f, line));
    assert.equal(github.createCalls.length, 1);
    assert.deepEqual(github.createCalls[0], {
      title: 'Propose the next patch after recovery-terminal calibration',
      body: proposalPullRequestBody({
        source: f.source,
        recovery: setup.graph.recovery,
        recoveryNumber: pr.number,
        line,
        proposal: first.proposal.sha,
      }),
      base: 'calibration/g1/recovery-terminal/line',
      head: 'calibration/g1/recovery-terminal/proposal',
      draft: true,
    });

    const pushes = git.pushes.length;
    github.proposals[0].title = 'Human-edited proposal title';
    github.proposals[0].body = 'Human-edited proposal body';
    const second = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(second.outcome, 'proposal-reused');
    assert.equal(second.proposal.sha, first.proposal.sha);
    assert.equal(second.proposal.pullNumber, first.proposal.pullNumber);
    assert.equal(github.createCalls.length, 1);
    assert.equal(git.pushes.length, pushes);
  } finally {
    f.cleanup();
  }
});

test('absent and closed-unmerged recovery suppress with no proposal mutation', async () => {
  for (const kind of ['absent', 'closed-unmerged']) {
    const { f, git, setup, github, pr } = await prepared();
    try {
      if (kind === 'absent') github.recovery = null;
      else Object.assign(pr, {
        state: 'closed',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
      });
      const pushes = git.pushes.length;
      const result = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
      assert.equal(result.outcome, `blocked-recovery-${kind}`);
      assert.equal(result.proposal, null);
      assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), null);
      assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), setup.graph.recovery);
      assert.equal(git.pushes.length, pushes);
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('wrong, protected, contradictory, and duplicate recovery histories fail closed', async () => {
  const mutations = [
    ['protected number', (pr) => { pr.number = 16; pr.html_url = 'https://github.com/fablebookjs/lab-01/pull/16'; }, /protected/],
    ['aliased URL', (pr) => { pr.html_url = 'https://github.com/fablebookjs/lab-01/pull/999'; }, /not canonical/],
    ['wrong base', (pr) => { pr.base.ref = 'main'; }, /base is not the exact/],
    ['wrong base repo', (pr) => { pr.base.repo.full_name = 'other/repo'; }, /base is not the exact/],
    ['wrong head', (pr) => { pr.head.sha = 'a'.repeat(40); }, /head is not the exact/],
    ['wrong head repo', (pr) => { pr.head.repo.full_name = 'other/repo'; }, /head is not the exact/],
    ['open merged', (pr) => { pr.merged = true; }, /contradictory/],
  ];
  for (const [, mutate, error] of mutations) {
    const { f, git, github, pr } = await prepared();
    try {
      mutate(pr);
      const pushes = git.pushes.length;
      await assert.rejects(runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }), error);
      assert.equal(git.pushes.length, pushes);
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }

  const { f, git, github, pr } = await prepared();
  try {
    github.listPullRequestHistoryPage = async ({ head, page }) =>
      page === 1 && head.endsWith('/recovery') ? [structuredClone(pr), structuredClone(pr)] : [];
    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /More than one historical recovery PR/,
    );
    assert.equal(github.createCalls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('recovery PR validator matches read-only PR16-23 open, conflict, and normal-merge tuple semantics', async () => {
  const { f, git, setup, pr } = await prepared();
  try {
    const mergeableOpen = verifyRecoveryPullRequest(pr, git, setup.graph, f.source);
    assert.equal(mergeableOpen.status, 'open');
    assert.equal(mergeableOpen.syntheticMergeSha, RECOVERY_SYNTHETIC_MERGE_SHA);
    const conflictShape = { ...structuredClone(pr), merge_commit_sha: null };
    const conflictingOpen = verifyRecoveryPullRequest(conflictShape, git, setup.graph, f.source);
    assert.equal(conflictingOpen.status, 'open');
    assert.equal(conflictingOpen.syntheticMergeSha, null);
    const openMutations = [
      [(value) => { delete value.number; }, /Invalid or protected calibration PR number/],
      [(value) => { value.number = null; }, /Invalid or protected calibration PR number/],
      [(value) => { value.number = '101'; }, /Invalid or protected calibration PR number/],
      [(value) => { value.html_url = null; }, /URL is not canonical/],
      [(value) => { delete value.merged; }, /merged field is not exact boolean/],
      [(value) => { value.merged = null; }, /merged field is not exact boolean/],
      [(value) => { value.merged = 'false'; }, /merged field is not exact boolean/],
      [(value) => { delete value.draft; }, /draft field is not exact false/],
      [(value) => { value.draft = null; }, /draft field is not exact false/],
      [(value) => { value.draft = 'false'; }, /draft field is not exact false/],
      [(value) => { value.state = 'OPEN'; }, /state is not exact open or closed/],
      [(value) => { delete value.merged_at; }, /contradictory state tuple/],
      [(value) => { value.merge_commit_sha = 'not-a-sha'; }, /Invalid commit identity/],
    ];
    for (const [mutate, error] of openMutations) {
      const forged = structuredClone(pr);
      mutate(forged);
      assert.throws(() => verifyRecoveryPullRequest(forged, git, setup.graph, f.source), error);
    }

    const closed = { ...structuredClone(pr), state: 'closed', merge_commit_sha: null };
    assert.equal(verifyRecoveryPullRequest(closed, git, setup.graph, f.source).status, 'closed-unmerged');
    for (const [mutate, error] of [
      [(value) => { value.base.sha = 'a'.repeat(40); }, /base is not the exact/],
      [(value) => { value.merge_commit_sha = 'a'.repeat(40); }, /Closed-unmerged.*contradictory/],
      [(value) => { value.merged_at = '2026-07-15T19:00:00Z'; }, /Closed-unmerged.*contradictory/],
    ]) {
      const forged = structuredClone(closed);
      mutate(forged);
      assert.throws(() => verifyRecoveryPullRequest(forged, git, setup.graph, f.source), error);
    }

    const mergedLine = normalMerge(f, setup.graph, pr);
    assert.equal(verifyRecoveryPullRequest(pr, git, setup.graph, mergedLine).status, 'merged');
    for (const [mutate, error] of [
      [(value) => { value.merged = null; }, /merged field is not exact boolean/],
      [(value) => { value.merged = false; }, /Closed-unmerged.*contradictory/],
      [(value) => { value.merged_at = null; }, /lacks exact merged timestamp/],
      [(value) => { value.merge_commit_sha = null; }, /Invalid commit identity/],
      [(value) => { value.base.sha = mergedLine; }, /base is not the exact/],
      [(value) => { value.draft = true; }, /draft field is not exact false/],
    ]) {
      const forged = structuredClone(pr);
      mutate(forged);
      assert.throws(() => verifyRecoveryPullRequest(forged, git, setup.graph, mergedLine), error);
    }
  } finally {
    f.cleanup();
  }
});

test('proposal PR validator accepts only live nullable/full synthetic open-draft tuple shapes', async () => {
  const { f, git, setup, line } = await prepared({ merge: true });
  try {
    const proposal = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    const state = {
      source: f.source,
      recovery: setup.graph.recovery,
      recoveryNumber: 101,
      line,
      proposal,
    };
    const input = {
      title: 'Propose the next patch after recovery-terminal calibration',
      body: proposalPullRequestBody(state),
      base: 'calibration/g1/recovery-terminal/line',
      head: 'calibration/g1/recovery-terminal/proposal',
      draft: true,
    };
    const exact = proposalPull(state, input);
    assert.equal(verifyProposalPullRequest(exact, state), exact);
    assert.equal(verifyProposalPullRequest({ ...structuredClone(exact), merge_commit_sha: null }, state).number, exact.number);
    const observedPr1ClosedShape = {
      ...structuredClone(exact),
      state: 'closed',
      merged: false,
      merged_at: null,
      merge_commit_sha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA,
    };
    assert.equal(
      verifyProposalHistoryPullRequest(observedPr1ClosedShape, state).status,
      'closed-unmerged',
    );
    assert.equal(
      verifyProposalHistoryPullRequest({ ...observedPr1ClosedShape, merge_commit_sha: null }, state).status,
      'closed-unmerged',
    );
    assert.throws(
      () => verifyProposalHistoryPullRequest({
        ...observedPr1ClosedShape,
        merge_commit_sha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA.toUpperCase(),
      }, state),
      /Invalid commit identity/,
    );
    assert.throws(
      () => verifyProposalPullRequest(observedPr1ClosedShape, state),
      /not one exact open draft/,
    );
    const mutations = [
      [(value) => { delete value.number; }, /Invalid or protected calibration PR number/],
      [(value) => { value.number = '102'; }, /Invalid or protected calibration PR number/],
      [(value) => { value.html_url = null; }, /URL is not canonical/],
      [(value) => { delete value.merged; }, /merged field is not exact boolean/],
      [(value) => { value.merged = null; }, /merged field is not exact boolean/],
      [(value) => { value.merged = 'false'; }, /merged field is not exact boolean/],
      [(value) => { delete value.draft; }, /draft field is not exact true/],
      [(value) => { value.draft = null; }, /draft field is not exact true/],
      [(value) => { value.draft = 'true'; }, /draft field is not exact true/],
      [(value) => { value.state = null; }, /state is not exact open or closed/],
      [(value) => { delete value.merge_commit_sha; }, /Invalid commit identity/],
      [(value) => { value.merge_commit_sha = 'not-a-sha'; }, /Invalid commit identity/],
      [(value) => { value.merged_at = '2026-07-15T19:00:00Z'; }, /contradictory state tuple/],
      [(value) => { value.base.sha = setup.graph.source; }, /base is not the exact/],
      [(value) => { value.head.ref = 'other'; }, /head is not the exact/],
      [(value) => { value.head.sha = setup.graph.recovery; }, /head is not the exact/],
      [(value) => { value.head.repo.full_name = 'other/repo'; }, /head is not the exact/],
      [(value) => { value.state = 'closed'; value.merge_commit_sha = null; }, /not one exact open draft/],
    ];
    for (const [mutate, error] of mutations) {
      const forged = structuredClone(exact);
      mutate(forged);
      assert.throws(() => verifyProposalPullRequest(forged, state), error);
    }
  } finally {
    f.cleanup();
  }
});

test('malformed recovery history and independently malformed hydrated detail both fail before writes', async () => {
  for (const surface of ['history', 'detail']) {
    const { f, git, github, pr } = await prepared();
    try {
      const exact = structuredClone(pr);
      const malformed = structuredClone(pr);
      delete malformed.merged;
      github.listPullRequestHistoryPage = async ({ head, page }) =>
        page === 1 && head.endsWith('/recovery')
          ? [structuredClone(surface === 'history' ? malformed : exact)]
          : [];
      github.getPullRequest = async () => structuredClone(surface === 'detail' ? malformed : exact);
      const pushes = git.pushes.length;
      await assert.rejects(
        runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
        /merged field is not exact boolean/,
      );
      assert.equal(git.pushes.length, pushes);
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('stale line, squash-like merge, and merge SHA mismatch cannot authorize proposal', async () => {
  for (const kind of ['stale', 'squash', 'sha-mismatch']) {
    const { f, git, setup, github, pr } = await prepared();
    try {
      if (kind === 'stale') {
        Object.assign(pr, {
          state: 'closed', merged: true, merged_at: '2026-07-15T19:00:00Z', merge_commit_sha: 'a'.repeat(40),
        });
      } else if (kind === 'squash') {
        const squash = command(f.runner, ['commit-tree', `${setup.graph.recovery}^{tree}`, '-p', setup.graph.source, '-m', 'squash']);
        command(f.runner, ['push', '--force', f.remote, `${squash}:${recoveryTerminalRef('line')}`]);
        Object.assign(pr, {
          state: 'closed',
          merged: true,
          merged_at: '2026-07-15T19:00:00Z',
          merge_commit_sha: squash,
        });
      } else {
        const line = normalMerge(f, setup.graph, pr);
        pr.merge_commit_sha = line.replace(/^./, line[0] === 'a' ? 'b' : 'a');
      }
      await assert.rejects(
        runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
        /Current fixed line|ordered \[source, recovery\] parents/,
      );
      assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), null);
      assert.equal(github.createCalls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('several retained closed proposal attempts plus one open exact PR reuse without POST', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    const created = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    const open = structuredClone(github.proposals[0]);
    const closed102 = {
      ...structuredClone(open),
      state: 'closed',
      merged: false,
      merged_at: null,
      merge_commit_sha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA,
    };
    const closed103 = {
      ...structuredClone(closed102),
      number: 103,
      html_url: 'https://github.com/fablebookjs/lab-01/pull/103',
      merge_commit_sha: null,
    };
    const open104 = {
      ...structuredClone(open),
      number: 104,
      html_url: 'https://github.com/fablebookjs/lab-01/pull/104',
    };
    github.proposals = [closed102, closed103, open104];
    const reused = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(reused.outcome, 'proposal-reused');
    assert.equal(reused.proposal.pullNumber, 104);
    assert.deepEqual(reused.proposal.closedPullNumbers, [102, 103]);
    assert.deepEqual(reused.proposal.closedPullAttempts, [
      { number: 102, syntheticMergeSha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA },
      { number: 103, syntheticMergeSha: null },
    ]);
    assert.equal(github.createCalls.length, 1);
    assert.equal(created.proposal.sha, reused.proposal.sha);
  } finally {
    f.cleanup();
  }
});

test('closed-only exact proposal history creates one replacement and preserves the stable proposal SHA', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    const first = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    Object.assign(github.proposals[0], {
      state: 'closed',
      merged: false,
      merged_at: null,
      merge_commit_sha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA,
    });
    const replacement = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(replacement.outcome, 'proposal-created');
    assert.equal(replacement.proposal.pullNumber, 103);
    assert.deepEqual(replacement.proposal.closedPullNumbers, [102]);
    assert.deepEqual(replacement.proposal.closedPullAttempts, [
      { number: 102, syntheticMergeSha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA },
    ]);
    assert.equal(replacement.proposal.sha, first.proposal.sha);
    assert.equal(github.proposals.length, 2);
    assert.equal(github.proposals.filter((pull) => pull.state === 'open').length, 1);
    assert.equal(github.createCalls.length, 2);

    const rerun = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(rerun.proposal.pullNumber, 103);
    assert.equal(github.createCalls.length, 2);

    Object.assign(github.proposals.find((pull) => pull.number === 103), {
      state: 'closed',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
    });
    const secondReplacement = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(secondReplacement.proposal.pullNumber, 104);
    assert.deepEqual(secondReplacement.proposal.closedPullNumbers, [102, 103]);
    assert.equal(github.createCalls.length, 3);
    assert.equal(github.proposals.filter((pull) => pull.state === 'open').length, 1);
  } finally {
    f.cleanup();
  }
});

test('proposal history rejects two open, any merged, duplicate records, or protected identities before POST', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    const open = structuredClone(github.proposals[0]);
    const cases = [
      [[open, { ...structuredClone(open), number: 103, html_url: 'https://github.com/fablebookjs/lab-01/pull/103' }], /More than one open proposal PR/],
      [[{ ...structuredClone(open), state: 'closed', merged: true, merged_at: '2026-07-15T20:00:00Z', merge_commit_sha: line }], /Merged proposal PR/],
      [[open, structuredClone(open)], /appears more than once in history/],
      [[{ ...structuredClone(open), number: 19, html_url: 'https://github.com/fablebookjs/lab-01/pull/19' }], /protected/],
    ];
    for (const [pulls, error] of cases) {
      github.proposals = pulls;
      await assert.rejects(runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }), error);
      assert.equal(github.createCalls.length, 1);
    }
  } finally {
    f.cleanup();
  }
});

test('lost successful proposal POST converges through all-state visibility without a duplicate', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.createPullRequest = async function createThenLose(input) {
      this.createCalls.push(structuredClone(input));
      this.proposals.push(proposalPull({ line, proposal: this.proposalSha }, input));
      throw new Error('connection lost after accepted POST');
    };
    const result = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(result.outcome, 'proposal-reused');
    assert.equal(result.proposal.pullAction, 'reused-after-ambiguous-create');
    assert.equal(github.createCalls.length, 1);
    const rerun = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(rerun.proposal.pullNumber, result.proposal.pullNumber);
    assert.equal(github.createCalls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('a definite first POST rejection remains resumable and the next run creates exactly once', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    let reject = true;
    github.createPullRequest = async function rejectThenCreate(input) {
      if (reject) {
        this.createCalls.push(structuredClone(input));
        throw new PullRequestPostError('unprocessable proposal payload', {
          kind: 'client-rejection',
          status: 422,
        });
      }
      return FakeGitHub.prototype.createPullRequest.call(this, input);
    };

    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /client-rejection has no visible open canonical PR.*later exact sweep may retry one POST/,
    );
    assert.equal(github.createCalls.length, 1);
    assert.equal(github.proposals.length, 0);
    assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), github.proposalSha);

    reject = false;
    const recovered = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(recovered.outcome, 'proposal-created');
    assert.equal(github.createCalls.length, 2);
    assert.equal(github.proposals.length, 1);
  } finally {
    f.cleanup();
  }
});

test('lost success can retry into duplicate refusal and converge when the single winner becomes visible', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    const proposal = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.proposalSha = proposal;
    let phase = 'lost-success';
    let hiddenPull = null;
    github.createPullRequest = async function loseThenRefuseDuplicate(input) {
      this.createCalls.push(structuredClone(input));
      if (phase === 'lost-success') {
        hiddenPull = proposalPull({ line, proposal }, input);
        throw new PullRequestPostError('socket closed after server accepted POST', { kind: 'ambiguous' });
      }
      phase = 'visible';
      throw new PullRequestPostError('A pull request already exists for these refs', {
        kind: 'duplicate',
        status: 422,
      });
    };
    github.listPullRequestHistoryPage = async (filter) => {
      if (filter.head.endsWith('/recovery')) return filter.page === 1 ? [structuredClone(github.recovery)] : [];
      if (filter.page !== 1) return [];
      return phase === 'visible' ? [structuredClone(hiddenPull)] : [];
    };

    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /ambiguous has no visible open canonical PR.*later exact sweep may retry one POST/,
    );
    assert.equal(github.createCalls.length, 1);
    phase = 'duplicate';
    const converged = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(converged.outcome, 'proposal-reused');
    assert.equal(converged.proposal.pullAction, 'reused-after-duplicate-refusal');
    assert.equal(github.createCalls.length, 2);
    assert.equal(hiddenPull.number, converged.proposal.pullNumber);
  } finally {
    f.cleanup();
  }
});

test('hidden accepted proposal that closes permits one later open replacement with closed history retained', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    const proposal = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.proposalSha = proposal;
    let phase = 'first-hidden';
    let hiddenClosed = null;
    let replacementOpen = null;
    github.createPullRequest = async function hiddenCloseThenReplace(input) {
      this.createCalls.push(structuredClone(input));
      if (phase === 'first-hidden') {
        hiddenClosed = proposalPull({ line, proposal }, input, 102);
        throw new PullRequestPostError('response lost after first create', { kind: 'ambiguous' });
      }
      replacementOpen = proposalPull({ line, proposal }, input, 103);
      phase = 'replacement-visible';
      return structuredClone(replacementOpen);
    };
    github.listPullRequestHistoryPage = async (filter) => {
      if (filter.head.endsWith('/recovery')) return filter.page === 1 ? [structuredClone(github.recovery)] : [];
      if (filter.page !== 1 || phase !== 'replacement-visible') return [];
      return [structuredClone(hiddenClosed), structuredClone(replacementOpen)];
    };

    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /ambiguous has no visible open canonical PR/,
    );
    Object.assign(hiddenClosed, {
      state: 'closed',
      merged: false,
      merged_at: null,
      merge_commit_sha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA,
    });
    phase = 'closed-hidden';

    const replacement = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(replacement.outcome, 'proposal-created');
    assert.equal(replacement.proposal.pullNumber, 103);
    assert.deepEqual(replacement.proposal.closedPullNumbers, [102]);
    assert.deepEqual(replacement.proposal.closedPullAttempts, [
      { number: 102, syntheticMergeSha: CLOSED_PROPOSAL_SYNTHETIC_MERGE_SHA },
    ]);
    assert.equal(replacement.proposal.sha, proposal);
    assert.equal(github.createCalls.length, 2);
  } finally {
    f.cleanup();
  }
});

test('repeated ambiguity and permanent invisibility remain one-POST-per-run retryable state', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.createPullRequest = async function alwaysAmbiguous(input) {
      this.createCalls.push(structuredClone(input));
      throw new PullRequestPostError('network outcome unavailable', { kind: 'ambiguous' });
    };

    for (let run = 1; run <= 3; run += 1) {
      await assert.rejects(
        runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
        /ambiguous has no visible open canonical PR.*later exact sweep may retry one POST/,
      );
      assert.equal(github.createCalls.length, run);
      assert.equal(github.proposals.length, 0);
      assert.equal(remoteRef(f, recoveryTerminalRef('proposal')), github.proposalSha);
      assert.equal(remoteRef(f, recoveryTerminalRef('pr-attempt')), github.proposalSha);
    }

    github.createPullRequest = FakeGitHub.prototype.createPullRequest;
    const corrected = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(corrected.outcome, 'proposal-created');
    assert.equal(github.createCalls.length, 4);
    assert.equal(github.proposals.length, 1);
  } finally {
    f.cleanup();
  }
});

test('successful response with no visible history remains safely retryable instead of stranded', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    github.proposalSha = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    const normalHistory = github.listPullRequestHistoryPage.bind(github);
    github.listPullRequestHistoryPage = async (filter) => {
      if (filter.head.endsWith('/recovery')) return normalHistory(filter);
      return [];
    };
    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /successful-response has no visible open canonical PR.*later exact sweep may retry one POST/,
    );
    assert.equal(github.createCalls.length, 1);
    assert.equal(github.proposals.length, 1);

    github.createPullRequest = async function duplicateWhileHidden(input) {
      this.createCalls.push(structuredClone(input));
      throw new PullRequestPostError('A pull request already exists for these refs', {
        kind: 'duplicate',
        status: 422,
      });
    };
    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /duplicate has no visible open canonical PR.*later exact sweep may retry one POST/,
    );
    assert.equal(github.createCalls.length, 2);
    assert.equal(github.proposals.length, 1);

    github.listPullRequestHistoryPage = normalHistory;
    const visible = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(visible.outcome, 'proposal-reused');
    assert.equal(github.createCalls.length, 2);
    assert.equal(github.proposals.length, 1);
  } finally {
    f.cleanup();
  }
});

test('successful response with delayed all-state visibility converges after one POST', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    const proposal = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.proposalSha = proposal;
    let proposalQueries = 0;
    github.listPullRequestHistoryPage = async function delayedHistory(filter) {
      if (filter.head.endsWith('/recovery')) return filter.page === 1 ? [structuredClone(this.recovery)] : [];
      if (filter.page !== 1) return [];
      proposalQueries += 1;
      return proposalQueries >= 3 ? structuredClone(this.proposals) : [];
    };
    const result = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(result.outcome, 'proposal-created');
    assert.equal(github.createCalls.length, 1);
    assert.ok(proposalQueries >= 3);
  } finally {
    f.cleanup();
  }
});

test('concurrent same-base/head winner is reused after duplicate refusal with one local POST', async () => {
  const { f, git, setup, github, line } = await prepared({ merge: true });
  try {
    const proposal = createProposalCommit(git, { line, recovery: setup.graph.recovery });
    github.proposalSha = proposal;
    github.createPullRequest = async function concurrentWinner(input) {
      this.createCalls.push(structuredClone(input));
      this.proposals.push(proposalPull({ line, proposal }, input, 104));
      throw new PullRequestPostError('A pull request already exists for these refs', {
        kind: 'duplicate',
        status: 422,
      });
    };
    const result = await runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github });
    assert.equal(result.outcome, 'proposal-reused');
    assert.equal(result.proposal.pullAction, 'reused-after-duplicate-refusal');
    assert.equal(github.createCalls.length, 1);
    assert.equal(github.proposals.length, 1);
    assert.equal(result.proposal.pullNumber, 104);
  } finally {
    f.cleanup();
  }
});

test('all-state pagination reaches later pages and duplicate recovery history fails closed', async () => {
  const { f, git, github, pr } = await prepared();
  try {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      ...structuredClone(pr),
      number: 200 + index,
      html_url: `https://github.com/fablebookjs/lab-01/pull/${200 + index}`,
    }));
    github.listPullRequestHistoryPage = async ({ head, page }) => {
      if (!head.endsWith('/recovery')) return [];
      if (page === 1) return pageOne;
      if (page === 2) return [structuredClone(pr)];
      return [];
    };
    await assert.rejects(
      runRecoveryTerminal({ mode: 'sweep', git, source: f.source, github }),
      /More than one historical recovery PR/,
    );
    assert.equal(github.createCalls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('remote advertisement and GitHub API identity reject hostile or malformed inputs', async () => {
  assert.deepEqual(
    parseRemoteAdvertisement(`${'a'.repeat(40)}\t${recoveryTerminalRef('source')}\n`, [recoveryTerminalRef('source')]),
    { [recoveryTerminalRef('source')]: 'a'.repeat(40) },
  );
  assert.throws(
    () => parseRemoteAdvertisement(`${'a'.repeat(40)} ${recoveryTerminalRef('source')}\n`, [recoveryTerminalRef('source')]),
    /Malformed/,
  );
  assert.throws(() => new GitHub({ token: 'bad\ntoken' }), /required/);
  assert.equal(
    classifyPullRequestResponse(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for these refs' }] }),
    'duplicate',
  );
  assert.equal(classifyPullRequestResponse(422, { message: 'Validation Failed' }), 'client-rejection');
  assert.equal(classifyPullRequestResponse(403, { message: 'Resource not accessible' }), 'client-rejection');
  assert.equal(classifyPullRequestResponse(429, { message: 'try later' }), 'ambiguous');
  assert.equal(classifyPullRequestResponse(503, { message: 'unavailable' }), 'ambiguous');
  const client = Object.create(GitHub.prototype);
  client.token = 'safe';
  await assert.rejects(client.request('/issues'), /Unsupported GitHub API path/);
  assert.throws(() => client.getPullRequest(-1), /Invalid pull request number/);
});

test('hostile Git environment, pushurl, URL rewrites, and unsafe local config stop before writes', async () => {
  const f = fixture();
  try {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = '/tmp/hostile';
    const hostile = new RecordingGit(gitOptions(f));
    await assert.rejects(
      runRecoveryTerminal({ mode: 'setup', git: hostile, source: f.source }),
      /Hostile inherited Git environment/,
    );
    assert.equal(hostile.pushes.length, 0);
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;

    command(f.runner, ['config', 'remote.origin.pushurl', f.remote]);
    const pushUrl = new RecordingGit(gitOptions(f));
    await assert.rejects(runRecoveryTerminal({ mode: 'setup', git: pushUrl, source: f.source }), /Unsafe repository Git config/);
    assert.equal(pushUrl.pushes.length, 0);
    command(f.runner, ['config', '--unset-all', 'remote.origin.pushurl']);

    command(f.runner, ['config', 'url.https://evil.invalid/.insteadOf', f.remote]);
    const rewrite = new RecordingGit(gitOptions(f));
    await assert.rejects(runRecoveryTerminal({ mode: 'setup', git: rewrite, source: f.source }), /Unsafe repository Git config/);
    assert.equal(rewrite.pushes.length, 0);
  } finally {
    delete process.env.GIT_DIR;
    f.cleanup();
  }
});

function parseWorkflowYaml(yaml) {
  const ruby = [
    'document = Psych.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false)',
    'trigger = document.key?("on") ? document["on"] : document[true]',
    'puts JSON.generate({"on" => trigger, "permissions" => document["permissions"], "concurrency" => document["concurrency"], "jobs" => document["jobs"]})',
  ].join('; ');
  return JSON.parse(execFileSync('ruby', ['-rpsych', '-rjson', '-e', ruby], { input: yaml, encoding: 'utf8' }));
}

test('workflows are manual trusted-main jobs with fixed non-cancelling concurrency and exact permissions', () => {
  const setup = readFileSync(new URL('../.github/workflows/calibrate-recovery-terminal-setup.yml', import.meta.url), 'utf8');
  const sweep = readFileSync(new URL('../.github/workflows/calibrate-recovery-terminal-sweep.yml', import.meta.url), 'utf8');
  for (const [kind, yaml, permissions] of [
    ['setup', setup, { contents: 'write' }],
    ['sweep', sweep, { contents: 'write', 'pull-requests': 'write' }],
  ]) {
    const parsed = parseWorkflowYaml(yaml);
    assert.deepEqual(parsed.on, { workflow_dispatch: null });
    assert.deepEqual(parsed.permissions, permissions);
    assert.deepEqual(parsed.concurrency, { group: 'calibration-g1-recovery-terminal', 'cancel-in-progress': false });
    for (const job of Object.values(parsed.jobs)) assert.ok(!Object.hasOwn(job, 'permissions'));
    assert.match(yaml, /test "\$GITHUB_REPOSITORY" = "fablebookjs\/lab-01"/);
    assert.match(yaml, /test "\$GITHUB_EVENT_NAME" = "workflow_dispatch"/);
    assert.match(yaml, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
    assert.match(yaml, /actions\/checkout@v7/);
    assert.match(yaml, /persist-credentials: false/);
    assert.match(yaml, /ref: \$\{\{ github\.sha \}\}/);
    assert.doesNotMatch(yaml, /pull_request(?:_target)?:|schedule:|push:|issues:|packages:|actions:|id-token:/);
    assert.match(yaml, new RegExp(`--mode ${kind}`));
  }
});

test('code exposes no release, publication, finalization, tag, package, or live-ref write surface', () => {
  const script = readFileSync(new URL('../scripts/calibrate-recovery-terminal.mjs', import.meta.url), 'utf8');
  const workflows = [
    readFileSync(new URL('../.github/workflows/calibrate-recovery-terminal-setup.yml', import.meta.url), 'utf8'),
    readFileSync(new URL('../.github/workflows/calibrate-recovery-terminal-sweep.yml', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(script, /refs\/tags\/|\/releases(?:\?|['"`])|\/dispatches|npm (?:publish|dist-tag)|refs\/heads\/(?:releases|release|staged)\//);
  assert.doesNotMatch(workflows, /refs\/tags\/|\/releases|npm |release\/|releases\/|staged\/|Storybook/);
  assert.deepEqual(
    [...script.matchAll(/this\.request\(([^,\n)]+)/g)].map((match) => match[1]).sort(),
    ['\'/pulls\'', '`/pulls/${number}`', '`/pulls?${query}`'],
  );
  assert.match(readFileSync(new URL('../docs/recovery-terminal-calibration.md', import.meta.url), 'utf8'), /remain exclusively owned by fablebookjs\/infra#19/);
});
