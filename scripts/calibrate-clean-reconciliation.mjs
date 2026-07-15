import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'fablebookjs/lab-01';
export const NAMESPACE = 'refs/heads/calibration/g1/reconciliation';
export const SCENARIOS = ['no-late', 'clean-late', 'concurrent-head'];

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Fablebook Lab Calibration',
  GIT_AUTHOR_EMAIL: 'lab-calibration@fablebook.invalid',
  GIT_AUTHOR_DATE: '2026-07-15T12:00:00Z',
  GIT_COMMITTER_NAME: 'Fablebook Lab Calibration',
  GIT_COMMITTER_EMAIL: 'lab-calibration@fablebook.invalid',
  GIT_COMMITTER_DATE: '2026-07-15T12:00:00Z',
};

export class Git {
  constructor({ cwd = process.cwd(), remote = 'origin' } = {}) {
    this.cwd = cwd;
    this.remote = remote;
  }

  run(args, { env = {}, input, allowFailure = false } = {}) {
    const result = spawnSync('git', args, {
      cwd: this.cwd,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', ...env },
      input,
    });

    if (result.error) throw result.error;
    if (!allowFailure && result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    return result;
  }

  text(args, options) {
    return this.run(args, options).stdout.trim();
  }
}

export function scenarioRef(scenario, leaf) {
  assertScenario(scenario);
  if (!/^[a-z][a-z0-9-]*$/.test(leaf)) throw new Error(`Invalid calibration ref leaf: ${leaf}`);
  return `${NAMESPACE}/${scenario}/${leaf}`;
}

export function assertCalibrationRef(ref) {
  if (
    !/^refs\/heads\/calibration\/g1\/reconciliation\/(?:no-late|clean-late|concurrent-head)\/[a-z][a-z0-9-]*$/.test(
      ref,
    )
  ) {
    throw new Error(`Ref is outside the fixed calibration namespace: ${ref}`);
  }
}

function assertScenario(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unsupported scenario: ${scenario}`);
}

function remoteHead(git, ref) {
  assertCalibrationRef(ref);
  const output = git.text(['ls-remote', '--heads', git.remote, ref]);
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length !== 1) throw new Error(`Expected one remote value for ${ref}`);
  const [sha, observedRef] = lines[0].split(/\s+/);
  if (observedRef !== ref || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Malformed remote value for ${ref}`);
  }
  return sha;
}

function pushWithLease(git, ref, expected, next) {
  assertCalibrationRef(ref);
  for (const sha of [expected, next]) {
    if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid commit identity: ${sha}`);
  }

  return git.run(
    [
      'push',
      '--porcelain',
      `--force-with-lease=${ref}:${expected ?? ''}`,
      git.remote,
      `${next}:${ref}`,
    ],
    { allowFailure: true },
  );
}

export function assertStaleLeaseRejection(push, ref, candidate) {
  const exact = `!\t${candidate}:${ref}\t[rejected] (stale info)`;
  if (push.status === 0 || !push.stdout.split('\n').includes(exact)) {
    throw new Error(
      `Expected Git to reject a stale lease for ${ref}: ${push.stdout.trim()} ${push.stderr.trim()}`,
    );
  }
}

function ensureFixedRef(git, ref, sha) {
  const observed = remoteHead(git, ref);
  if (observed === sha) return 'reused';
  if (observed !== null) {
    throw new Error(`Fixed calibration ref ${ref} is ${observed}, expected ${sha}`);
  }

  const push = pushWithLease(git, ref, null, sha);
  if (push.status !== 0) {
    const winner = remoteHead(git, ref);
    if (winner === sha) return 'reused-race-winner';
    throw new Error(`Could not create ${ref} at ${sha}: ${push.stderr.trim()}`);
  }
  if (remoteHead(git, ref) !== sha) throw new Error(`Remote verification failed for ${ref}`);
  return 'created';
}

function advanceFixedLine(git, ref, expected, next) {
  const observed = remoteHead(git, ref);
  if (observed === next) return 'reused';
  if (observed !== expected) {
    throw new Error(`Calibration line ${ref} is ${observed ?? 'absent'}, expected ${expected}`);
  }

  const push = pushWithLease(git, ref, expected, next);
  if (push.status !== 0) {
    throw new Error(`Guarded update of ${ref} was rejected: ${push.stderr.trim()}`);
  }
  if (remoteHead(git, ref) !== next) throw new Error(`Remote verification failed for ${ref}`);
  return 'advanced';
}

function commitTree(git, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  return git.text(args, { env: COMMIT_ENV, input: `${message}\n` });
}

function treeWithFile(git, base, path, content) {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-reconciliation-index-'));
  const index = join(root, 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    git.run(['read-tree', `${base}^{tree}`], { env });
    const blob = git.text(['hash-object', '-w', '--stdin'], { input: content });
    git.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
    return git.text(['write-tree'], { env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mergeTree(git, firstParent, secondParent) {
  const result = git.run(['merge-tree', '--write-tree', firstParent, secondParent], {
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new Error(`Expected a clean calibration merge: ${result.stdout.trim()} ${result.stderr.trim()}`);
  }
  const tree = result.stdout.trim().split('\n')[0];
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Git did not return a merge tree');
  return tree;
}

function parents(git, sha) {
  return git.text(['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

function tree(git, sha) {
  return git.text(['show', '-s', '--format=%T', sha]);
}

function createGraph(git, scenario, source) {
  git.run(['cat-file', '-e', `${source}^{commit}`]);
  const sourceTree = tree(git, source);
  const intent = commitTree(git, sourceTree, [source], `calibration intent: ${scenario}`);
  const m = commitTree(git, sourceTree, [source, intent], `calibration M: ${scenario}`);
  const prefix = `calibration/g1/reconciliation/${scenario}`;
  const versionTree = treeWithFile(git, m, `${prefix}/version.txt`, '1.0.1\n');
  const v = commitTree(git, versionTree, [m], `calibration V: ${scenario}`);
  const graph = { source, intent, m, v };

  if (scenario !== 'no-late') {
    const lateTree = treeWithFile(git, m, `${prefix}/late.txt`, 'late work for the next patch\n');
    const h = commitTree(git, lateTree, [m], `calibration H: ${scenario}`);
    const jTree = mergeTree(git, h, v);
    const j = commitTree(git, jTree, [h, v], `calibration J: ${scenario}`);
    Object.assign(graph, { h, j });
  }

  if (scenario === 'concurrent-head') {
    const h2Tree = treeWithFile(
      git,
      graph.h,
      `${prefix}/concurrent.txt`,
      'a second late commit won the race\n',
    );
    graph.h2 = commitTree(git, h2Tree, [graph.h], `calibration H2: ${scenario}`);
  }

  return graph;
}

function verifyGraph(git, scenario, graph) {
  if (tree(git, graph.intent) !== tree(git, graph.source)) throw new Error('Intent is not empty');
  if (parents(git, graph.intent).join(' ') !== graph.source) throw new Error('Intent parent is wrong');
  if (parents(git, graph.m).join(' ') !== `${graph.source} ${graph.intent}`) {
    throw new Error('M does not preserve source and intent parents in order');
  }
  if (parents(git, graph.v).join(' ') !== graph.m) throw new Error('V parent is not M');

  if (scenario !== 'no-late') {
    if (parents(git, graph.h).join(' ') !== graph.m) throw new Error('H parent is not M');
    if (parents(git, graph.j).join(' ') !== `${graph.h} ${graph.v}`) {
      throw new Error('J parents are not [H, V]');
    }
    for (const leaf of ['late.txt', 'version.txt']) {
      git.run(['cat-file', '-e', `${graph.j}:calibration/g1/reconciliation/${scenario}/${leaf}`]);
    }
  }

  if (scenario === 'concurrent-head') {
    if (parents(git, graph.h2).join(' ') !== graph.h) throw new Error('H2 parent is not H');
  }
}

function installGraphRefs(git, scenario, graph) {
  const results = {};
  for (const [leaf, sha] of Object.entries(graph)) {
    results[leaf] = ensureFixedRef(git, scenarioRef(scenario, leaf), sha);
  }
  return results;
}

export function runCalibration({ scenario, git = new Git(), source }) {
  assertScenario(scenario);
  if (!/^[0-9a-f]{40}$/.test(source)) throw new Error(`Invalid source SHA: ${source}`);

  const sourceRef = scenarioRef(scenario, 'source');
  const pinnedSource = remoteHead(git, sourceRef) ?? source;
  const graph = createGraph(git, scenario, pinnedSource);
  verifyGraph(git, scenario, graph);
  const refResults = installGraphRefs(git, scenario, graph);
  const lineRef = scenarioRef(scenario, 'line');
  let outcome;
  let stalePushRejected = false;

  if (scenario === 'no-late') {
    const current = remoteHead(git, lineRef);
    if (current === graph.v) {
      outcome = 'reused';
    } else {
      if (current === null) ensureFixedRef(git, lineRef, graph.m);
      else if (current !== graph.m) throw new Error(`Unexpected no-late line head: ${current}`);
      outcome = advanceFixedLine(git, lineRef, graph.m, graph.v);
    }
  } else if (scenario === 'clean-late') {
    const current = remoteHead(git, lineRef);
    if (current === graph.j) {
      outcome = 'reused';
    } else {
      if (current === null) ensureFixedRef(git, lineRef, graph.h);
      else if (current !== graph.h) throw new Error(`Unexpected clean-late line head: ${current}`);
      outcome = advanceFixedLine(git, lineRef, graph.h, graph.j);
    }
  } else {
    const current = remoteHead(git, lineRef);
    if (current === null) ensureFixedRef(git, lineRef, graph.h);
    else if (current !== graph.h && current !== graph.h2) {
      throw new Error(`Unexpected concurrent line head: ${current}`);
    }
    if (remoteHead(git, lineRef) === graph.h) {
      advanceFixedLine(git, lineRef, graph.h, graph.h2);
    }
    const stalePush = pushWithLease(git, lineRef, graph.h, graph.j);
    assertStaleLeaseRejection(stalePush, lineRef, graph.j);
    if (remoteHead(git, lineRef) !== graph.h2) {
      throw new Error('Concurrent-head rejection did not preserve H2');
    }
    outcome = 'stale-reconciliation-rejected';
    stalePushRejected = true;
  }

  const finalHead = remoteHead(git, lineRef);
  const expectedFinal = scenario === 'no-late' ? graph.v : scenario === 'clean-late' ? graph.j : graph.h2;
  if (finalHead !== expectedFinal) throw new Error(`Final line ${finalHead} is not ${expectedFinal}`);

  return { scenario, outcome, stalePushRejected, lineRef, finalHead, graph, refResults };
}

function assertLiveContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Wrong GitHub repository');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Wrong GitHub event');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Calibration must dispatch from main');
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  if (!['https://github.com/fablebookjs/lab-01', 'https://github.com/fablebookjs/lab-01.git'].includes(remote)) {
    throw new Error(`Wrong origin: ${remote}`);
  }
}

function summary(result) {
  const rows = Object.entries(result.graph)
    .map(([role, sha]) => `| ${role.toUpperCase()} | \`${sha}\` |`)
    .join('\n');
  return `## G1 clean reconciliation calibration\n\n` +
    `- Scenario: \`${result.scenario}\`\n` +
    `- Outcome: \`${result.outcome}\`\n` +
    `- Event: \`${process.env.GITHUB_EVENT_NAME}\`\n` +
    `- Actor: \`${process.env.GITHUB_ACTOR}\`\n` +
    `- Triggering actor: \`${process.env.GITHUB_TRIGGERING_ACTOR}\`\n` +
    `- Run: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n` +
    `- Permission used: \`contents: write\` only\n` +
    `- Final calibration line: \`${result.lineRef}\` = \`${result.finalHead}\`\n` +
    `- Concurrent stale push rejected: \`${result.stalePushRejected}\`\n\n` +
    `| Role | Commit |\n| --- | --- |\n${rows}\n`;
}

async function main() {
  assertLiveContext();
  const scenarioIndex = process.argv.indexOf('--scenario');
  const scenario = scenarioIndex === -1 ? null : process.argv[scenarioIndex + 1];
  assertScenario(scenario);
  const source = new Git().text(['rev-parse', 'HEAD']);
  const result = runCalibration({ scenario, source });
  const markdown = summary(result);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
