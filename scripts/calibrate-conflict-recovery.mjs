import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'fablebookjs/lab-01';
export const NAMESPACE = 'refs/heads/calibration/g1/conflict-recovery';
export const FILE_PATH = 'calibration/g1/conflict-recovery/recovery.txt';
export const MODES = ['inject-after-force', 'resume'];
export const INTENTIONAL_FAILURE_EXIT_CODE = 78;

const ROLES = ['source', 'intent', 'm', 'v', 'h', 'backup', 'line'];
const FIXED_GRAPH_ROLES = ['source', 'intent', 'm', 'v', 'h'];
const REF_SET = new Set(ROLES.map((role) => `${NAMESPACE}/${role}`));
const PR_TITLE = 'Recover conflict calibration work after 1.0.1';
const LIVE_REMOTE_URLS = [
  'https://github.com/fablebookjs/lab-01',
  'https://github.com/fablebookjs/lab-01.git',
];
const POST_CREATE_HISTORY_ATTEMPTS = 4;
const POST_CREATE_RETRY_MS = 100;

const HOSTILE_GIT_ENVIRONMENT = [
  /^GIT_ALTERNATE_OBJECT_DIRECTORIES$/,
  /^GIT_CEILING_DIRECTORIES$/,
  /^GIT_COMMON_DIR$/,
  /^GIT_CONFIG$/,
  /^GIT_CONFIG_COUNT$/,
  /^GIT_CONFIG_GLOBAL$/,
  /^GIT_CONFIG_KEY_\d+$/,
  /^GIT_CONFIG_NOSYSTEM$/,
  /^GIT_CONFIG_PARAMETERS$/,
  /^GIT_CONFIG_SYSTEM$/,
  /^GIT_CONFIG_VALUE_\d+$/,
  /^GIT_DIR$/,
  /^GIT_DISCOVERY_ACROSS_FILESYSTEM$/,
  /^GIT_GRAFT_FILE$/,
  /^GIT_INDEX_FILE$/,
  /^GIT_NAMESPACE$/,
  /^GIT_OBJECT_DIRECTORY$/,
  /^GIT_REPLACE_REF_BASE$/,
  /^GIT_SHALLOW_FILE$/,
  /^GIT_WORK_TREE$/,
];

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Fablebook Lab Conflict Calibration',
  GIT_AUTHOR_EMAIL: 'lab-conflict-calibration@fablebook.invalid',
  GIT_AUTHOR_DATE: '2026-07-15T14:00:00Z',
  GIT_COMMITTER_NAME: 'Fablebook Lab Conflict Calibration',
  GIT_COMMITTER_EMAIL: 'lab-conflict-calibration@fablebook.invalid',
  GIT_COMMITTER_DATE: '2026-07-15T14:00:00Z',
};

export class Git {
  constructor({ cwd = process.cwd(), remote = 'origin', acceptedRemoteUrls = LIVE_REMOTE_URLS } = {}) {
    this.cwd = cwd;
    this.remote = remote;
    this.acceptedRemoteUrls = new Set(acceptedRemoteUrls);
  }

  run(args, { env = {}, input, allowFailure = false } = {}) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key))),
    );
    const result = spawnSync('git', args, {
      cwd: this.cwd,
      encoding: 'utf8',
      env: { ...inherited, LC_ALL: 'C', ...env },
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

  hostileEnvironmentKeys() {
    return Object.keys(process.env).filter((key) =>
      HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)),
    );
  }

  assertTrustedPushDestination() {
    const hostile = this.hostileEnvironmentKeys();
    if (hostile.length > 0) {
      throw new Error(`Hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    }
    if (this.remote !== 'origin') throw new Error(`Git writes require the exact origin remote, got ${this.remote}`);

    const pushUrls = this.run(['config', '--get-all', 'remote.origin.pushurl'], { allowFailure: true });
    if (pushUrls.status !== 1 || pushUrls.stdout.trim()) {
      throw new Error('Explicit remote.origin.pushurl is forbidden');
    }
    const rewrites = this.run(
      ['config', '--show-origin', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'],
      { allowFailure: true },
    );
    if (rewrites.status !== 1 || rewrites.stdout.trim()) {
      throw new Error('Configured Git URL rewrites are forbidden');
    }

    const fetchUrls = this.text(['remote', 'get-url', '--all', 'origin']).split('\n').filter(Boolean);
    const effectivePushUrls = this.text(['remote', 'get-url', '--push', '--all', 'origin'])
      .split('\n')
      .filter(Boolean);
    if (fetchUrls.length !== 1 || !this.acceptedRemoteUrls.has(fetchUrls[0])) {
      throw new Error(`Untrusted effective origin fetch URL(s): ${fetchUrls.join(', ') || 'none'}`);
    }
    if (effectivePushUrls.length !== 1 || !this.acceptedRemoteUrls.has(effectivePushUrls[0])) {
      throw new Error(`Untrusted effective origin push URL(s): ${effectivePushUrls.join(', ') || 'none'}`);
    }
    return { fetchUrl: fetchUrls[0], pushUrl: effectivePushUrls[0] };
  }
}

export class GitHub {
  constructor({ token = process.env.GITHUB_TOKEN } = {}) {
    if (!token) throw new Error('GITHUB_TOKEN is required for recovery PR operations');
    this.token = token;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`GitHub returned non-JSON status ${response.status}`);
      }
    }
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${payload?.message ?? text}`);
    }
    return payload;
  }

  listPullRequestHistory({ base, head }) {
    const query = new URLSearchParams({ state: 'all', base, head, per_page: '100' });
    return this.request(`/pulls?${query}`);
  }

  createPullRequest(input) {
    return this.request('/pulls', { method: 'POST', body: input });
  }

  waitForRetry(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export function conflictRef(role) {
  if (!ROLES.includes(role)) throw new Error(`Unsupported conflict calibration ref role: ${role}`);
  return `${NAMESPACE}/${role}`;
}

export function assertConflictRef(ref) {
  if (!REF_SET.has(ref)) {
    throw new Error(`Ref is outside the exact conflict calibration namespace: ${ref}`);
  }
}

function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid commit identity: ${sha}`);
}

function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`Unsupported conflict recovery mode: ${mode}`);
}

function remoteHead(git, ref) {
  assertConflictRef(ref);
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

export function pushWithLease(git, ref, expected, next) {
  assertConflictRef(ref);
  if (expected !== null) assertSha(expected);
  assertSha(next);
  git.assertTrustedPushDestination();
  return git.run(
    [
      'push',
      '--porcelain',
      '--no-follow-tags',
      `--force-with-lease=${ref}:${expected ?? ''}`,
      git.remote,
      `${next}:${ref}`,
    ],
    { allowFailure: true },
  );
}

function pushAtomicRecovery(git, graph) {
  const backupRef = conflictRef('backup');
  const lineRef = conflictRef('line');
  for (const sha of [graph.h, graph.v]) assertSha(sha);
  git.assertTrustedPushDestination();
  return git.run(
    [
      'push',
      '--porcelain',
      '--atomic',
      '--no-follow-tags',
      `--force-with-lease=${backupRef}:${graph.h}`,
      `--force-with-lease=${lineRef}:${graph.h}`,
      git.remote,
      `${graph.h}:${backupRef}`,
      `${graph.v}:${lineRef}`,
    ],
    { allowFailure: true },
  );
}

function ensureFixedRef(git, ref, sha) {
  assertConflictRef(ref);
  assertSha(sha);
  const observed = remoteHead(git, ref);
  if (observed === sha) return 'reused';
  if (observed !== null) {
    throw new Error(`Fixed conflict calibration ref ${ref} is ${observed}, expected ${sha}`);
  }

  const push = pushWithLease(git, ref, null, sha);
  if (push.status !== 0) {
    const winner = remoteHead(git, ref);
    if (winner === sha) return 'reused-race-winner';
    throw new Error(`Could not create ${ref} at ${sha}: ${push.stderr.trim() || push.stdout.trim()}`);
  }
  if (remoteHead(git, ref) !== sha) throw new Error(`Remote verification failed for ${ref}`);
  return 'created';
}

function commitTree(git, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  return git.text(args, { env: COMMIT_ENV, input: `${message}\n` });
}

function treeWithFile(git, base, path, content) {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-conflict-index-'));
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

function parents(git, sha) {
  return git.text(['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

function tree(git, sha) {
  return git.text(['show', '-s', '--format=%T', sha]);
}

function changedPaths(git, from, to) {
  return git.text(['diff-tree', '--no-commit-id', '--name-only', '-r', from, to]).split('\n').filter(Boolean);
}

export function createGraph(git, source) {
  assertSha(source);
  git.run(['cat-file', '-e', `${source}^{commit}`]);
  const sourceTree = tree(git, source);
  const intent = commitTree(git, sourceTree, [source], 'conflict calibration intent');
  const m = commitTree(git, sourceTree, [source, intent], 'conflict calibration M');
  const versionTree = treeWithFile(git, m, FILE_PATH, 'release snapshot for 1.0.1\n');
  const v = commitTree(git, versionTree, [m], 'conflict calibration V');
  const lateTree = treeWithFile(git, m, FILE_PATH, 'complete late work for the recovery patch\n');
  const h = commitTree(git, lateTree, [m], 'conflict calibration H');
  return { source, intent, m, v, h };
}

export function verifyGraph(git, graph) {
  for (const sha of Object.values(graph)) {
    assertSha(sha);
    git.run(['cat-file', '-e', `${sha}^{commit}`]);
  }
  if (parents(git, graph.intent).join(' ') !== graph.source) throw new Error('Intent parent is not source');
  if (tree(git, graph.intent) !== tree(git, graph.source)) throw new Error('Intent is not empty');
  if (parents(git, graph.m).join(' ') !== `${graph.source} ${graph.intent}`) {
    throw new Error('M does not preserve ordered [source, intent] parents');
  }
  if (tree(git, graph.m) !== tree(git, graph.source)) throw new Error('M changed the source tree');
  if (parents(git, graph.v).join(' ') !== graph.m) throw new Error('V parent is not M');
  if (parents(git, graph.h).join(' ') !== graph.m) throw new Error('H parent is not M');
  if (changedPaths(git, graph.m, graph.v).join(' ') !== FILE_PATH) {
    throw new Error('V does not change only the fixed conflict path');
  }
  if (changedPaths(git, graph.m, graph.h).join(' ') !== FILE_PATH) {
    throw new Error('H does not change only the fixed conflict path');
  }
  if (git.text(['show', `${graph.v}:${FILE_PATH}`]) !== 'release snapshot for 1.0.1') {
    throw new Error('V does not contain the fixed release snapshot');
  }
  if (git.text(['show', `${graph.h}:${FILE_PATH}`]) !== 'complete late work for the recovery patch') {
    throw new Error('H is not the complete fixed late-work head');
  }

  const merge = git.run(['merge-tree', '--write-tree', graph.v, graph.h], { allowFailure: true });
  const conflictLines = merge.stdout.split('\n').filter((line) => line.startsWith('CONFLICT '));
  const exactConflict = `CONFLICT (add/add): Merge conflict in ${FILE_PATH}`;
  if (merge.status !== 1 || conflictLines.length !== 1 || conflictLines[0] !== exactConflict) {
    throw new Error(`V and H did not produce the required genuine conflict: ${merge.stdout} ${merge.stderr}`);
  }
  return { kind: 'add/add', path: FILE_PATH, mergeTreeExit: merge.status };
}

function installFixedGraphRefs(git, graph) {
  const refResults = {};
  for (const role of FIXED_GRAPH_ROLES) {
    refResults[role] = ensureFixedRef(git, conflictRef(role), graph[role]);
  }
  return refResults;
}

function prepareFixedGraph(git, source) {
  assertSha(source);
  const existingSource = remoteHead(git, conflictRef('source'));
  if (existingSource !== null && existingSource !== source) {
    throw new Error(`Trusted main source drifted from fixed calibration source ${existingSource} to ${source}`);
  }
  const pinnedSource = existingSource ?? source;
  const graph = createGraph(git, pinnedSource);
  const conflict = verifyGraph(git, graph);
  const refResults = installFixedGraphRefs(git, graph);
  return { graph, conflict, refResults };
}

function requireCompatibleLine(git, graph, { createIfAbsent }) {
  const lineRef = conflictRef('line');
  let current = remoteHead(git, lineRef);
  let result = 'reused';
  if (current === null && createIfAbsent) {
    result = ensureFixedRef(git, lineRef, graph.h);
    current = remoteHead(git, lineRef);
  }
  if (current !== graph.h && current !== graph.v) {
    throw new Error(
      `Conflict calibration line ${lineRef} is ${current ?? 'absent'}, expected ${graph.h} or ${graph.v}`,
    );
  }
  return { current, result };
}

function ensureOrRequireBackup(git, graph, { createIfAbsent }) {
  const backupRef = conflictRef('backup');
  const observed = remoteHead(git, backupRef);
  let result = 'reused';
  if (observed === null && createIfAbsent) result = ensureFixedRef(git, backupRef, graph.h);
  else if (observed !== graph.h) {
    throw new Error(
      `Fixed recovery backup ${backupRef} is ${observed ?? 'absent'}, expected complete H ${graph.h}`,
    );
  }

  return { result, ...verifyRemoteBackup(git, graph) };
}

function verifyRemoteBackup(git, graph) {
  const backupRef = conflictRef('backup');
  const remoteBackup = remoteHead(git, backupRef);
  if (remoteBackup !== graph.h) throw new Error(`Remote recovery backup is ${remoteBackup}, expected ${graph.h}`);
  const lateCommits = [graph.h];
  for (const late of lateCommits) {
    const reachable = git.run(['merge-base', '--is-ancestor', late, remoteBackup], { allowFailure: true });
    if (reachable.status !== 0) {
      throw new Error(`Late commit ${late} is not reachable from remote-backed H ${remoteBackup}`);
    }
  }
  return { remoteBackup, lateCommits };
}

function forceLineToSnapshot(git, graph) {
  const lineRef = conflictRef('line');
  const observed = remoteHead(git, lineRef);
  if (observed === graph.v) {
    const backup = verifyRemoteBackup(git, graph);
    return { result: 'reused-release-snapshot', finalHead: graph.v, backup };
  }
  if (observed !== graph.h) {
    throw new Error(`Conflict calibration line is ${observed ?? 'absent'}, expected complete H ${graph.h}`);
  }
  verifyRemoteBackup(git, graph);
  const push = pushAtomicRecovery(git, graph);
  if (push.status !== 0) {
    const observedBackup = remoteHead(git, conflictRef('backup'));
    const observedLine = remoteHead(git, lineRef);
    if (observedBackup === graph.h && observedLine === graph.v) {
      return {
        result: 'forced-h-to-v-lost-success',
        finalHead: observedLine,
        backup: verifyRemoteBackup(git, graph),
      };
    }
    if (
      isExactStaleLeaseRejection(push, conflictRef('backup'), graph.h) ||
      isExactStaleLeaseRejection(push, lineRef, graph.v)
    ) {
      throw new Error(
        `Stale atomic lease rejected recovery force; backup=${observedBackup ?? 'absent'}, line=${observedLine ?? 'absent'}`,
      );
    }
    throw new Error(
      `Atomic H-to-V force failed without stale-lease proof; backup=${observedBackup ?? 'absent'}, line=${observedLine ?? 'absent'}: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
  const finalHead = remoteHead(git, lineRef);
  if (finalHead !== graph.v) throw new Error(`Remote line ${finalHead} is not exact V ${graph.v}`);
  const backup = verifyRemoteBackup(git, graph);
  return { result: 'forced-h-to-v', finalHead, backup };
}

export function isExactStaleLeaseRejection(push, ref, candidate) {
  assertConflictRef(ref);
  assertSha(candidate);
  const exact = `!\t${candidate}:${ref}\t[rejected] (stale info)`;
  return push.status !== 0 && push.stdout.split('\n').includes(exact);
}

export function recoveryPullRequestBody(graph) {
  return (
    `This draft restores the complete late-work head after the fixed calibration line was forced to the 1.0.1 release snapshot.\n\n` +
    `- Excluded late SHA(s): \`${graph.h}\`\n` +
    `- Resolvable lab author: @ndelangen\n` +
    `- This work missed 1.0.1; another patch is required.\n` +
    `- The branches conflict, and those conflicts must be resolved before recovery can proceed.\n\n` +
    `This is retained calibration evidence only; it does not publish, tag, merge, or modify the live release proposal.`
  );
}

function verifyRecoveryPullRequest(pr, graph, { requireEditableFields = false } = {}) {
  const base = conflictRef('line').replace('refs/heads/', '');
  const head = conflictRef('backup').replace('refs/heads/', '');
  if (!Number.isInteger(pr.number) || pr.number <= 0 || pr.number === 12) {
    throw new Error(`Invalid or protected recovery PR number: ${pr.number}`);
  }
  const canonicalUrl = `https://github.com/${REPOSITORY}/pull/${pr.number}`;
  if (pr.html_url !== canonicalUrl) throw new Error(`Recovery PR URL is not canonical for #${pr.number}`);
  if (pr.state !== 'open' || pr.draft !== true) throw new Error('Recovery PR is not one open draft');
  if (requireEditableFields && (pr.title !== PR_TITLE || pr.body !== recoveryPullRequestBody(graph))) {
    throw new Error('Created recovery PR title or body does not match the fixed payload');
  }
  if (pr.base?.ref !== base || pr.base?.sha !== graph.v || pr.base?.repo?.full_name !== REPOSITORY) {
    throw new Error('Recovery PR base is not the exact calibration line at V');
  }
  if (pr.head?.ref !== head || pr.head?.sha !== graph.h || pr.head?.repo?.full_name !== REPOSITORY) {
    throw new Error('Recovery PR head is not the same-repository backup at complete H');
  }
  return pr;
}

async function ensureRecoveryPullRequest(github, graph) {
  if (!github) throw new Error('A GitHub client is required only for resume mode');
  const base = conflictRef('line').replace('refs/heads/', '');
  const head = conflictRef('backup').replace('refs/heads/', '');
  const qualifiedHead = `fablebookjs:${head}`;
  let pulls = await github.listPullRequestHistory({ base, head: qualifiedHead });
  if (!Array.isArray(pulls)) throw new Error('GitHub did not return a pull request list');
  if (pulls.length > 1) throw new Error('More than one historical recovery PR exists for the fixed refs');
  if (pulls.length === 1) {
    return { action: 'reused', pull: verifyRecoveryPullRequest(pulls[0], graph) };
  }

  const created = await github.createPullRequest({
    title: PR_TITLE,
    body: recoveryPullRequestBody(graph),
    base,
    head,
    draft: true,
  });
  verifyRecoveryPullRequest(created, graph, { requireEditableFields: true });
  for (let attempt = 1; attempt <= POST_CREATE_HISTORY_ATTEMPTS; attempt += 1) {
    pulls = await github.listPullRequestHistory({ base, head: qualifiedHead });
    if (!Array.isArray(pulls)) throw new Error('GitHub did not return a pull request list');
    if (pulls.length > 0) break;
    if (attempt < POST_CREATE_HISTORY_ATTEMPTS) {
      const wait =
        github.waitForRetry?.bind(github) ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      await wait(POST_CREATE_RETRY_MS * attempt);
    }
  }
  if (pulls.length !== 1) {
    throw new Error('Recovery PR creation did not converge to exactly one all-state historical PR');
  }
  const verified = verifyRecoveryPullRequest(pulls[0], graph);
  if (verified.number !== created.number) throw new Error('Recovery PR identity changed after creation');
  return { action: 'created', pull: verified };
}

export async function runConflictRecovery({ mode, git = new Git(), source, github = null }) {
  assertMode(mode);
  assertSha(source);
  git.assertTrustedPushDestination();
  const prepared = prepareFixedGraph(git, source);
  const createEvidenceRefs = mode === 'inject-after-force';
  const line = requireCompatibleLine(git, prepared.graph, { createIfAbsent: createEvidenceRefs });
  const backup = ensureOrRequireBackup(git, prepared.graph, { createIfAbsent: createEvidenceRefs });
  const forced = forceLineToSnapshot(git, prepared.graph);
  const finalBackup = verifyRemoteBackup(git, prepared.graph);

  const result = {
    mode,
    graph: prepared.graph,
    conflict: prepared.conflict,
    fixedRefResults: prepared.refResults,
    lineRef: conflictRef('line'),
    lineInitialResult: line.result,
    forceResult: forced.result,
    finalLine: forced.finalHead,
    backupRef: conflictRef('backup'),
    backupResult: backup.result,
    remoteBackup: finalBackup.remoteBackup,
    lateCommits: finalBackup.lateCommits,
  };

  if (mode === 'inject-after-force') {
    return {
      ...result,
      outcome: 'intentional-failure-after-durable-force-before-pr',
      intentionalFailure: true,
      failurePoint: 'after-durable-force-before-pr',
      pullRequest: null,
    };
  }

  const pr = await ensureRecoveryPullRequest(github, prepared.graph);
  return {
    ...result,
    outcome: pr.action === 'created' ? 'recovery-pr-created' : 'recovery-pr-reused',
    intentionalFailure: false,
    failurePoint: null,
    pullRequest: {
      action: pr.action,
      number: pr.pull.number,
      url: pr.pull.html_url,
      draft: pr.pull.draft,
    },
  };
}

export function buildSummary(result) {
  const rows = Object.entries(result.graph)
    .map(([role, sha]) => `| ${role.toUpperCase()} | \`${sha}\` |`)
    .join('\n');
  const pr = result.pullRequest
    ? `- Recovery PR: [#${result.pullRequest.number}](${result.pullRequest.url}) (\`${result.pullRequest.action}\`, draft)\n`
    : '- Recovery PR: not created\n';
  return (
    `## G1 conflict recovery calibration\n\n` +
    `- Mode: \`${result.mode}\`\n` +
    `- Outcome: \`${result.outcome}\`\n` +
    `- Intentional failure point: \`${result.failurePoint ?? 'none'}\`\n` +
    `- Remote backup: \`${result.backupRef}\` = \`${result.remoteBackup}\`\n` +
    `- Final calibration line: \`${result.lineRef}\` = \`${result.finalLine}\`\n` +
    `- Excluded late SHA(s), all reachable from remote backup: ${result.lateCommits.map((sha) => `\`${sha}\``).join(', ')}\n` +
    `- Proven conflict: \`${result.conflict.kind}\` at \`${result.conflict.path}\`\n` +
    `- Event: \`${process.env.GITHUB_EVENT_NAME}\`\n` +
    `- Actor: \`${process.env.GITHUB_ACTOR}\`\n` +
    `- Triggering actor: \`${process.env.GITHUB_TRIGGERING_ACTOR}\`\n` +
    `- Permission used: \`contents: write\`, \`pull-requests: write\`\n` +
    pr +
    `\n| Role | Commit |\n| --- | --- |\n${rows}\n`
  );
}

export function finalizeResult(
  result,
  {
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    outputPath = process.env.GITHUB_OUTPUT,
    writeStdout = (text) => process.stdout.write(text),
  } = {},
) {
  const json = JSON.stringify(result, null, 2);
  if (summaryPath) appendFileSync(summaryPath, buildSummary(result));
  if (outputPath) {
    appendFileSync(
      outputPath,
      `evidence<<CONFLICT_RECOVERY_EVIDENCE\n${json}\nCONFLICT_RECOVERY_EVIDENCE\n` +
        `failure_point=${result.failurePoint ?? ''}\n` +
        `backup_ref=${result.backupRef}\n` +
        `backup_sha=${result.remoteBackup}\n` +
        `line_ref=${result.lineRef}\n` +
        `line_sha=${result.finalLine}\n` +
        `pr_number=${result.pullRequest?.number ?? ''}\n`,
    );
  }
  writeStdout(`${json}\n`);
  return result.intentionalFailure ? INTENTIONAL_FAILURE_EXIT_CODE : 0;
}

function assertLiveContext(git) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Wrong GitHub repository');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Wrong GitHub event');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Conflict calibration must dispatch from main');
  const head = git.text(['rev-parse', 'HEAD']);
  if (head !== process.env.GITHUB_SHA) throw new Error('Checked-out commit is not the trusted dispatch SHA');
  git.assertTrustedPushDestination();
}

async function main() {
  const git = new Git();
  assertLiveContext(git);
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? null : process.argv[modeIndex + 1];
  assertMode(mode);
  const source = git.text(['rev-parse', 'HEAD']);
  const github = mode === 'resume' ? new GitHub() : null;
  const result = await runConflictRecovery({ mode, git, source, github });
  process.exitCode = finalizeResult(result);
  if (result.intentionalFailure) {
    console.error('Intentional calibration failure after durable H -> V force and before PR creation');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
