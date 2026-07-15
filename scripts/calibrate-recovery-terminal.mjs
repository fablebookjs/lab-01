import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'fablebookjs/lab-01';
export const NAMESPACE = 'refs/heads/calibration/g1/recovery-terminal';
export const FILE_PATH = 'calibration/g1/recovery-terminal/recovery.txt';
export const MODES = ['setup', 'sweep'];
export const ROLES = ['source', 'line', 'recovery', 'proposal', 'pr-attempt'];

const REF_SET = new Set(ROLES.map((role) => `${NAMESPACE}/${role}`));
const PROTECTED_PULL_REQUESTS = new Set([12, 16, 19, 21, 23]);
const RECOVERY_TITLE = 'Complete dedicated recovery-terminal calibration';
const PROPOSAL_TITLE = 'Propose the next patch after recovery-terminal calibration';
const RECOVERY_CONTENT = 'dedicated recovery-terminal completion\n';
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;
const VISIBILITY_ATTEMPTS = 4;
const VISIBILITY_RETRY_MS = 100;
const NULL_DEVICE = '/dev/null';
const LIVE_REMOTE_URLS = [
  'https://github.com/fablebookjs/lab-01',
  'https://github.com/fablebookjs/lab-01.git',
];
const SAFE_LOCAL_CONFIG = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'gc.auto',
  'push.followtags',
  'remote.origin.url',
  'remote.origin.fetch',
  'user.name',
  'user.email',
]);
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
  /^GIT_EXEC_PATH$/,
  /^GIT_GRAFT_FILE$/,
  /^GIT_ASKPASS$/,
  /^GIT_CREDENTIAL_/,
  /^GIT_CURL_VERBOSE$/,
  /^GIT_HTTP_PROXY_AUTHMETHOD$/,
  /^GIT_INDEX_FILE$/,
  /^GIT_NAMESPACE$/,
  /^GIT_OBJECT_DIRECTORY$/,
  /^GIT_PROXY_COMMAND$/,
  /^GIT_REPLACE_REF_BASE$/,
  /^GIT_SHALLOW_FILE$/,
  /^GIT_SSL_/,
  /^GIT_SSH(?:_COMMAND|_VARIANT)?$/,
  /^GIT_TERMINAL_PROMPT$/,
  /^GIT_TRACE/,
  /^GIT_WORK_TREE$/,
  /^GCM_/,
  /^SSH_ASKPASS(?:_REQUIRE)?$/,
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^CURL_/,
  /^NETRC$/i,
];
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Fablebook Recovery Terminal Calibration',
  GIT_AUTHOR_EMAIL: 'lab-recovery-terminal@fablebook.invalid',
  GIT_AUTHOR_DATE: '2026-07-15T18:00:00Z',
  GIT_COMMITTER_NAME: 'Fablebook Recovery Terminal Calibration',
  GIT_COMMITTER_EMAIL: 'lab-recovery-terminal@fablebook.invalid',
  GIT_COMMITTER_DATE: '2026-07-15T18:00:00Z',
};

export function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid commit identity: ${sha}`);
}

export function recoveryTerminalRef(role) {
  if (!ROLES.includes(role)) throw new Error(`Unsupported recovery-terminal role: ${role}`);
  return `${NAMESPACE}/${role}`;
}

export function assertRecoveryTerminalRef(ref) {
  if (!REF_SET.has(ref)) throw new Error(`Ref is outside the exact recovery-terminal namespace: ${ref}`);
}

export function parseRemoteAdvertisement(output, refs) {
  const uniqueRefs = [...new Set(refs)];
  if (uniqueRefs.length !== refs.length || uniqueRefs.length === 0) {
    throw new Error('Remote advertisement requires unique requested refs');
  }
  const observed = Object.fromEntries(uniqueRefs.map((ref) => [ref, null]));
  for (const line of output.split('\n').filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{40})\t([^\t\r\n ]+)$/);
    if (!match) throw new Error('Malformed remote advertisement record');
    const [, sha, ref] = match;
    if (!Object.hasOwn(observed, ref)) throw new Error(`Unexpected advertised ref: ${ref}`);
    if (observed[ref] !== null) throw new Error(`Duplicate advertised ref: ${ref}`);
    observed[ref] = sha;
  }
  return observed;
}

export class Git {
  constructor({
    cwd = process.cwd(),
    remote = 'origin',
    acceptedRemoteUrls = LIVE_REMOTE_URLS,
    liveNetworkWrite = process.env.GITHUB_ACTIONS === 'true',
    token = process.env.GITHUB_TOKEN,
  } = {}) {
    this.cwd = cwd;
    this.remote = remote;
    this.acceptedRemoteUrls = new Set(acceptedRemoteUrls);
    this.liveNetworkWrite = liveNetworkWrite;
    this.token = token;
    this.authorizationHeader = null;
    this.trustedSource = null;
  }

  hostileEnvironmentKeys() {
    return Object.keys(process.env).filter((key) =>
      HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)),
    );
  }

  controlledNetworkEnvironment() {
    return this.authorizationHeader === null
      ? {}
      : {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: this.authorizationHeader,
        };
  }

  bindLiveWriteAuthentication() {
    if (!this.liveNetworkWrite || this.authorizationHeader !== null) return;
    if (typeof this.token !== 'string' || !this.token || /[\r\n]/.test(this.token)) {
      throw new Error('GITHUB_TOKEN is required for live calibration writes');
    }
    this.authorizationHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    this.token = null;
  }

  run(args, { env = {}, input, allowFailure = false, network = false, requireAuthentication = false } = {}) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'GITHUB_TOKEN' && !HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)),
      ),
    );
    if (requireAuthentication && this.liveNetworkWrite && this.authorizationHeader === null) {
      throw new Error('Controlled authentication is not bound for live Git network write');
    }
    const result = spawnSync('git', args, {
      cwd: this.cwd,
      encoding: 'utf8',
      env: {
        ...inherited,
        ...env,
        LC_ALL: 'C',
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        HOME: NULL_DEVICE,
        XDG_CONFIG_HOME: NULL_DEVICE,
        ...(network ? this.controlledNetworkEnvironment() : {}),
      },
      input,
    });
    if (result.error) throw result.error;
    if (!allowFailure && result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }

  text(args, options) {
    return this.run(args, options).stdout.trim();
  }

  localConfigEntries() {
    const result = this.run(['config', '--local', '--null', '--get-regexp', '.*'], { allowFailure: true });
    if (result.status === 1 && !result.stdout) return [];
    if (result.status !== 0) throw new Error(`Could not audit repository Git config: ${result.stderr.trim()}`);
    return result.stdout.split('\0').filter(Boolean).map((record) => {
      const separator = record.indexOf('\n');
      if (separator <= 0) throw new Error('Malformed repository Git config record');
      return [record.slice(0, separator).toLowerCase(), record.slice(separator + 1)];
    });
  }

  assertSafeLocalConfig() {
    const counts = new Map();
    let originUrl = null;
    for (const [key, value] of this.localConfigEntries()) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const branchMatch = key.match(/^branch\.(.+)\.(remote|merge)$/);
      if (branchMatch) {
        const valid = branchMatch[2] === 'remote'
          ? value === 'origin'
          : /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
        if (!valid) throw new Error(`Unsafe repository Git config: ${key}`);
        continue;
      }
      if (!SAFE_LOCAL_CONFIG.has(key)) throw new Error(`Unsafe repository Git config: ${key}`);
      if (key === 'remote.origin.url') {
        if (!this.acceptedRemoteUrls.has(value)) throw new Error('Untrusted repository origin URL');
        originUrl = value;
      } else if (key === 'remote.origin.fetch') {
        if (!/^\+?refs\/heads\/[A-Za-z0-9.*_/-]+:refs\/remotes\/origin\/[A-Za-z0-9.*_/-]+$/.test(value)) {
          throw new Error('Unsafe repository Git config: remote.origin.fetch');
        }
      } else if (key === 'core.repositoryformatversion' && value !== '0') {
        throw new Error('Unsupported repository format');
      } else if (key === 'core.bare' && value !== 'false') {
        throw new Error('Calibration requires a non-bare checkout');
      } else if (
        ['core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'push.followtags']
          .includes(key) && !['true', 'false'].includes(value.toLowerCase())
      ) {
        throw new Error(`Unsafe repository Git config: ${key}`);
      } else if (key === 'gc.auto' && value !== '0') {
        throw new Error('Unsafe repository Git config: gc.auto');
      }
    }
    if (counts.get('remote.origin.url') !== 1 || originUrl === null) {
      throw new Error('Repository must have one exact origin URL');
    }
    return { originUrl };
  }

  assertTrustedRemote({ requirePush = false } = {}) {
    const hostile = this.hostileEnvironmentKeys();
    if (hostile.length > 0) throw new Error(`Hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    if (this.remote !== 'origin') throw new Error(`Git operations require exact origin, got ${this.remote}`);
    const { originUrl } = this.assertSafeLocalConfig();
    if (requirePush) this.bindLiveWriteAuthentication();
    if (requirePush && this.trustedSource !== null) this.assertTrustedSource();
    return { fetchUrl: originUrl, pushUrl: requirePush ? originUrl : null };
  }

  remoteRef(ref) {
    if (ref !== 'refs/heads/main') assertRecoveryTerminalRef(ref);
    this.assertTrustedRemote();
    const output = this.text(['ls-remote', '--heads', this.remote, ref], { network: true });
    return parseRemoteAdvertisement(output, [ref])[ref];
  }

  bindTrustedSource(source) {
    assertSha(source);
    this.trustedSource = source;
    this.assertTrustedSource();
  }

  assertTrustedSource() {
    if (this.trustedSource === null) throw new Error('Trusted source has not been bound');
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_SHA !== this.trustedSource) {
      throw new Error(`GITHUB_SHA ${process.env.GITHUB_SHA} is not trusted source ${this.trustedSource}`);
    }
    const localHead = this.text(['rev-parse', 'HEAD']);
    if (localHead !== this.trustedSource) throw new Error(`Local HEAD ${localHead} is not trusted source ${this.trustedSource}`);
    const remote = this.remoteRef('refs/heads/main');
    if (remote !== this.trustedSource) {
      throw new Error(`Remote refs/heads/main ${remote ?? 'absent'} is not trusted source ${this.trustedSource}`);
    }
    return this.trustedSource;
  }
}

export class GitHub {
  constructor({ token = process.env.GITHUB_TOKEN } = {}) {
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
      throw new Error('GITHUB_TOKEN is required for pull request operations');
    }
    this.token = token;
  }

  async request(path, { method = 'GET', body } = {}) {
    if (!/^\/pulls(?:\?|\/\d+$|$)/.test(path)) throw new Error(`Unsupported GitHub API path: ${path}`);
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new PullRequestPostError(`GitHub ${method} ${path} transport failed`, {
        kind: 'ambiguous',
        cause: error,
      });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new PullRequestPostError(`GitHub returned non-JSON status ${response.status}`, {
          kind: method === 'POST' ? 'ambiguous' : 'client-rejection',
          status: response.status,
        });
      }
    }
    if (!response.ok) {
      throw new PullRequestPostError(
        `GitHub ${method} ${path} failed (${response.status}): ${payload?.message ?? text}`,
        {
          kind: classifyPullRequestResponse(response.status, payload),
          status: response.status,
        },
      );
    }
    return payload;
  }

  async listPullRequestHistoryPage({ base, head, page }) {
    const query = new URLSearchParams({
      state: 'all',
      base,
      head,
      per_page: String(HISTORY_PAGE_SIZE),
      page: String(page),
    });
    const listed = await this.request(`/pulls?${query}`);
    if (!Array.isArray(listed)) return listed;
    const hydrated = [];
    for (const pull of listed) {
      if (!Number.isInteger(pull?.number) || pull.number <= 0) {
        throw new Error('GitHub pull request history contained an invalid number');
      }
      hydrated.push(await this.getPullRequest(pull.number));
    }
    return hydrated;
  }

  createPullRequest(input) {
    return this.request('/pulls', { method: 'POST', body: input });
  }

  getPullRequest(number) {
    if (!Number.isInteger(number) || number <= 0) throw new Error(`Invalid pull request number: ${number}`);
    return this.request(`/pulls/${number}`);
  }

  waitForRetry(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

export class PullRequestPostError extends Error {
  constructor(message, { kind, status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    if (!['client-rejection', 'duplicate', 'ambiguous'].includes(kind)) {
      throw new Error(`Unsupported pull request POST error kind: ${kind}`);
    }
    if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
      throw new Error(`Invalid HTTP status: ${status}`);
    }
    this.name = 'PullRequestPostError';
    this.kind = kind;
    this.status = status;
  }
}

function responseErrorText(payload) {
  const values = [payload?.message];
  if (Array.isArray(payload?.errors)) {
    for (const error of payload.errors) values.push(typeof error === 'string' ? error : error?.message);
  }
  return values.filter((value) => typeof value === 'string').join(' ');
}

export function classifyPullRequestResponse(status, payload) {
  if (!Number.isInteger(status)) throw new Error(`Invalid HTTP status: ${status}`);
  const message = responseErrorText(payload);
  if (
    status === 422 &&
    /(?:pull request.*already exists|already exists.*pull request)/i.test(message)
  ) {
    return 'duplicate';
  }
  if (status >= 500 || [408, 425, 429].includes(status)) return 'ambiguous';
  return 'client-rejection';
}

function classifyPullRequestPostError(error) {
  return error instanceof PullRequestPostError ? error.kind : 'ambiguous';
}

function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`Unsupported recovery-terminal mode: ${mode}`);
}

function tree(git, sha) {
  return git.text(['show', '-s', '--format=%T', sha]);
}

function parents(git, sha) {
  return git.text(['show', '-s', '--format=%P', sha]).split(' ').filter(Boolean);
}

function ensureCommitAvailable(git, sha) {
  assertSha(sha);
  const local = git.run(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true });
  if (local.status === 0) return;
  git.assertTrustedRemote({ requirePush: true });
  git.run(['fetch', '--no-tags', '--no-write-fetch-head', git.remote, sha], {
    network: true,
    requireAuthentication: true,
  });
  git.run(['cat-file', '-e', `${sha}^{commit}`]);
}

function commitTree(git, treeSha, parent, message) {
  return git.text(['commit-tree', treeSha, '-p', parent], { env: COMMIT_ENV, input: `${message}\n` });
}

function treeWithRecoveryFile(git, source) {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-recovery-terminal-index-'));
  const index = join(root, 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    git.run(['read-tree', `${source}^{tree}`], { env });
    const blob = git.text(['hash-object', '-w', '--stdin'], { input: RECOVERY_CONTENT });
    git.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE_PATH}`], { env });
    return git.text(['write-tree'], { env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function createRecoveryGraph(git, source) {
  assertSha(source);
  git.run(['cat-file', '-e', `${source}^{commit}`]);
  const recoveryTree = treeWithRecoveryFile(git, source);
  const recovery = commitTree(git, recoveryTree, source, 'recovery-terminal dedicated recovery');
  return { source, line: source, recovery };
}

export function verifyRecoveryGraph(git, graph) {
  for (const sha of Object.values(graph)) {
    assertSha(sha);
    git.run(['cat-file', '-e', `${sha}^{commit}`]);
  }
  if (graph.line !== graph.source) throw new Error('Initial line is not exact source');
  if (parents(git, graph.recovery).join(' ') !== graph.source) throw new Error('Recovery parent is not exact source');
  const changed = git.text(['diff-tree', '--no-commit-id', '--name-only', '-r', graph.source, graph.recovery]);
  if (changed !== FILE_PATH) throw new Error('Recovery does not change only the fixed path');
  const entry = git.text(['ls-tree', graph.recovery, '--', FILE_PATH]);
  const expectedBlob = git.text(['hash-object', '--stdin'], { input: RECOVERY_CONTENT });
  if (entry !== `100644 blob ${expectedBlob}\t${FILE_PATH}`) throw new Error('Recovery file entry is not canonical');
  if (git.text(['show', `${graph.recovery}:${FILE_PATH}`]) !== RECOVERY_CONTENT.trim()) {
    throw new Error('Recovery file content is not canonical');
  }
  return graph;
}

export function proposalMessage({ line, recovery }) {
  for (const sha of [line, recovery]) assertSha(sha);
  return (
    'recovery-terminal next patch proposal\n\n' +
    `Proposal-Base: calibration/g1/recovery-terminal/line\n` +
    `Proposal-Version: 1.0.2\n` +
    `Recovered-Line: ${line}\n` +
    `Recovery-Head: ${recovery}`
  );
}

export function createProposalCommit(git, state) {
  return commitTree(git, tree(git, state.line), state.line, proposalMessage(state));
}

export function verifyProposalCommit(git, proposal, state) {
  assertSha(proposal);
  git.run(['cat-file', '-e', `${proposal}^{commit}`]);
  if (parents(git, proposal).join(' ') !== state.line) throw new Error('Proposal parent is not exact recovered line');
  if (tree(git, proposal) !== tree(git, state.line)) throw new Error('Proposal commit is not empty');
  if (git.text(['show', '-s', '--format=%B', proposal]) !== proposalMessage(state)) {
    throw new Error('Proposal message or trailers are not canonical');
  }
  return proposal;
}

export function pushWithLease(git, ref, expected, next) {
  assertRecoveryTerminalRef(ref);
  if (expected !== null) assertSha(expected);
  assertSha(next);
  git.assertTrustedRemote({ requirePush: true });
  return git.run([
    'push',
    '--porcelain',
    '--no-follow-tags',
    `--force-with-lease=${ref}:${expected ?? ''}`,
    git.remote,
    `${next}:${ref}`,
  ], { allowFailure: true, network: true, requireAuthentication: true });
}

function exactStaleLease(push, ref, candidate) {
  return push.status !== 0 && push.stdout.split('\n').includes(`!\t${candidate}:${ref}\t[rejected] (stale info)`);
}

function ensureFixedRef(git, ref, sha) {
  const observed = git.remoteRef(ref);
  if (observed === sha) return 'reused';
  if (observed !== null) throw new Error(`Fixed recovery-terminal ref ${ref} is ${observed}, expected ${sha}`);
  const push = pushWithLease(git, ref, null, sha);
  if (push.status !== 0) {
    const winner = git.remoteRef(ref);
    if (winner === sha && exactStaleLease(push, ref, sha)) return 'reused-race-winner';
    throw new Error(`Could not create ${ref} at ${sha}: ${push.stderr.trim() || push.stdout.trim()}`);
  }
  if (git.remoteRef(ref) !== sha) throw new Error(`Remote verification failed for ${ref}`);
  return 'created';
}

function advanceFixedRef(git, ref, expected, next) {
  const observed = git.remoteRef(ref);
  if (observed === next) return 'reused';
  if (observed !== expected) {
    throw new Error(`Fixed recovery-terminal state ${ref} is ${observed ?? 'absent'}, expected ${expected}`);
  }
  const push = pushWithLease(git, ref, expected, next);
  if (push.status !== 0) {
    const winner = git.remoteRef(ref);
    if (winner === next && exactStaleLease(push, ref, next)) return 'advanced-lost-success';
    throw new Error(`Guarded update of ${ref} failed; observed ${winner ?? 'absent'}: ${push.stderr.trim() || push.stdout.trim()}`);
  }
  if (git.remoteRef(ref) !== next) throw new Error(`Remote verification failed for ${ref}`);
  return 'advanced';
}

function assertSetupRefs(git, graph) {
  for (const [role, sha] of Object.entries({
    source: graph.source,
    line: graph.line,
    recovery: graph.recovery,
    'pr-attempt': graph.recovery,
  })) {
    const observed = git.remoteRef(recoveryTerminalRef(role));
    if (observed !== sha) throw new Error(`Fixed ${role} ref is ${observed ?? 'absent'}, expected ${sha}`);
  }
  const proposal = git.remoteRef(recoveryTerminalRef('proposal'));
  if (proposal !== null) throw new Error(`Setup requires absent proposal ref, observed ${proposal}`);
}

export function runSetup({ git = new Git(), source }) {
  assertSha(source);
  git.assertTrustedRemote({ requirePush: true });
  git.bindTrustedSource(source);
  const graph = verifyRecoveryGraph(git, createRecoveryGraph(git, source));
  const results = {};
  for (const [role, sha] of Object.entries({
    source: graph.source,
    line: graph.line,
    recovery: graph.recovery,
    'pr-attempt': graph.recovery,
  })) {
    results[role] = ensureFixedRef(git, recoveryTerminalRef(role), sha);
  }
  assertSetupRefs(git, graph);
  return {
    mode: 'setup',
    outcome: 'recovery-ready-for-operator-pr',
    graph,
    refResults: results,
    recoveryPullRequest: {
      title: RECOVERY_TITLE,
      base: recoveryTerminalRef('line').replace('refs/heads/', ''),
      head: recoveryTerminalRef('recovery').replace('refs/heads/', ''),
    },
  };
}

function pullQuery(role) {
  const base = recoveryTerminalRef('line').replace('refs/heads/', '');
  const head = recoveryTerminalRef(role).replace('refs/heads/', '');
  return { base, head: `fablebookjs:${head}` };
}

async function listHistory(github, git, query, assertState) {
  const pulls = [];
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    assertState();
    const values = await github.listPullRequestHistoryPage({ ...query, page });
    assertState();
    if (!Array.isArray(values)) throw new Error('GitHub did not return a pull request history page');
    if (values.length > HISTORY_PAGE_SIZE) throw new Error(`GitHub history page ${page} exceeded its fixed size`);
    pulls.push(...values);
    if (values.length < HISTORY_PAGE_SIZE) return pulls;
  }
  throw new Error(`Pull request history exceeded the fixed ${MAX_HISTORY_PAGES}-page limit`);
}

function assertPullNumber(pr) {
  if (!Number.isInteger(pr.number) || pr.number <= 0 || PROTECTED_PULL_REQUESTS.has(pr.number)) {
    throw new Error(`Invalid or protected calibration PR number: ${pr.number}`);
  }
  if (pr.html_url !== `https://github.com/${REPOSITORY}/pull/${pr.number}`) {
    throw new Error(`Calibration PR URL is not canonical for #${pr.number}`);
  }
}

function assertPullRefs(pr, role, { baseSha, headSha }) {
  const base = recoveryTerminalRef('line').replace('refs/heads/', '');
  const head = recoveryTerminalRef(role).replace('refs/heads/', '');
  if (
    pr.base?.ref !== base ||
    pr.base?.sha !== baseSha ||
    pr.base?.repo?.full_name !== REPOSITORY
  ) {
    throw new Error('Calibration PR base is not the exact same-repository fixed line');
  }
  if (pr.head?.ref !== head || pr.head?.sha !== headSha || pr.head?.repo?.full_name !== REPOSITORY) {
    throw new Error(`Calibration PR head is not the exact same-repository ${role} ref`);
  }
}

function assertPullStateTuple(pr, { expectedDraft }) {
  if (pr.state !== 'open' && pr.state !== 'closed') {
    throw new Error(`Calibration PR state is not exact open or closed: ${pr.state}`);
  }
  if (typeof pr.merged !== 'boolean') throw new Error('Calibration PR merged field is not exact boolean');
  if (typeof pr.draft !== 'boolean' || pr.draft !== expectedDraft) {
    throw new Error(`Calibration PR draft field is not exact ${expectedDraft}`);
  }

  if (pr.state === 'open') {
    if (pr.merged !== false || pr.merged_at !== null || pr.merge_commit_sha !== null) {
      throw new Error('Open calibration PR has a contradictory state tuple');
    }
    return 'open';
  }

  if (pr.merged === false) {
    if (pr.merged_at !== null || pr.merge_commit_sha !== null) {
      throw new Error('Closed-unmerged calibration PR has a contradictory state tuple');
    }
    return 'closed-unmerged';
  }

  if (typeof pr.merged_at !== 'string' || !pr.merged_at) {
    throw new Error('Closed-merged calibration PR lacks exact merged timestamp');
  }
  assertSha(pr.merge_commit_sha);
  return 'closed-merged';
}

function selectSingleHistory(pulls, kind) {
  if (pulls.length > 1) throw new Error(`More than one historical ${kind} PR exists for the fixed refs`);
  return pulls[0] ?? null;
}

function assertProposalStillSuppressed(graph, initialProposal, initialMarker) {
  if (initialProposal !== null) {
    throw new Error(`Recovery is not merged but proposal ref already exists at ${initialProposal}`);
  }
  if (initialMarker !== graph.recovery) {
    throw new Error('Recovery is not merged but PR-attempt marker is not exact recovery head');
  }
}

export function verifyRecoveryPullRequest(pr, git, graph, currentLine) {
  assertPullNumber(pr);
  const tuple = assertPullStateTuple(pr, { expectedDraft: false });
  const expectedBase = tuple === 'closed-merged' ? currentLine : graph.source;
  assertPullRefs(pr, 'recovery', { baseSha: expectedBase, headSha: graph.recovery });
  if (tuple === 'open') {
    if (currentLine !== graph.source) throw new Error('Recovery PR is open but fixed line is not exact source');
    return { status: 'open', pull: pr };
  }
  if (tuple === 'closed-unmerged') {
    if (currentLine !== graph.source) throw new Error('Closed unmerged recovery PR changed the fixed line');
    return { status: 'closed-unmerged', pull: pr };
  }
  if (currentLine !== pr.merge_commit_sha) throw new Error('Current fixed line is not the recovery PR merge commit');
  ensureCommitAvailable(git, currentLine);
  if (parents(git, currentLine).join(' ') !== `${graph.source} ${graph.recovery}`) {
    throw new Error('Recovery merge does not have exact ordered [source, recovery] parents');
  }
  if (tree(git, currentLine) !== tree(git, graph.recovery)) {
    throw new Error('Recovery merge tree is not exact recovery tree');
  }
  return { status: 'merged', pull: pr, line: currentLine };
}

export function proposalPullRequestBody(state) {
  return (
    `This draft is the one empty next-patch proposal authorized only after dedicated recovery PR #${state.recoveryNumber} merged normally.\n\n` +
    `- Recovered line: \`${state.line}\`\n` +
    `- Recovery head: \`${state.recovery}\`\n` +
    `- Proposal commit: \`${state.proposal}\`\n\n` +
    `This calibration stops at proposal creation. Integrated finalization and public publication remain owned by fablebookjs/infra#19.`
  );
}

export function verifyProposalPullRequest(pr, state, { requireEditableFields = false } = {}) {
  assertPullNumber(pr);
  const tuple = assertPullStateTuple(pr, { expectedDraft: true });
  assertPullRefs(pr, 'proposal', { baseSha: state.line, headSha: state.proposal });
  if (tuple !== 'open') throw new Error('Proposal PR is not one exact open draft');
  if (requireEditableFields && (pr.title !== PROPOSAL_TITLE || pr.body !== proposalPullRequestBody(state))) {
    throw new Error('Created proposal PR editable payload is not canonical');
  }
  return pr;
}

function assertSweepAnchors(git, source, graph, { line = null, marker = null, proposal = undefined } = {}) {
  git.assertTrustedSource();
  if (git.remoteRef(recoveryTerminalRef('source')) !== source) throw new Error('Fixed source ref drifted');
  if (git.remoteRef(recoveryTerminalRef('recovery')) !== graph.recovery) throw new Error('Fixed recovery ref drifted');
  if (line !== null && git.remoteRef(recoveryTerminalRef('line')) !== line) throw new Error('Fixed line drifted');
  if (marker !== null && git.remoteRef(recoveryTerminalRef('pr-attempt')) !== marker) {
    throw new Error('Fixed PR-attempt marker drifted');
  }
  if (proposal !== undefined && git.remoteRef(recoveryTerminalRef('proposal')) !== proposal) {
    throw new Error('Fixed proposal ref drifted');
  }
}

async function pollProposalHistory(github, git, query, assertState) {
  let pulls = [];
  for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
    pulls = await listHistory(github, git, query, assertState);
    if (pulls.length > 0) return pulls;
    if (attempt < VISIBILITY_ATTEMPTS) {
      await (github.waitForRetry?.(VISIBILITY_RETRY_MS * attempt) ?? Promise.resolve());
    }
  }
  return pulls;
}

async function ensureProposalPullRequest(github, git, state) {
  const query = pullQuery('proposal');
  const markerRef = recoveryTerminalRef('pr-attempt');
  let marker = git.remoteRef(markerRef);
  const assertState = () => assertSweepAnchors(git, state.source, { recovery: state.recovery }, {
    line: state.line,
    marker,
    proposal: state.proposal,
  });
  if (marker !== state.recovery && marker !== state.proposal) {
    throw new Error(`PR-attempt marker is ${marker ?? 'absent'}, expected recovery or proposal`);
  }
  let pulls = await listHistory(github, git, query, assertState);
  let existing = selectSingleHistory(pulls, 'proposal');
  if (existing) return { action: 'reused', pull: verifyProposalPullRequest(existing, state) };

  let markerResult = 'reused';
  if (marker === state.recovery) {
    markerResult = advanceFixedRef(git, markerRef, state.recovery, state.proposal);
    marker = git.remoteRef(markerRef);
    if (marker !== state.proposal) throw new Error('PR-attempt marker did not reach exact proposal');
  }

  let created = null;
  let postError = null;
  let postOutcome = 'successful-response';
  try {
    assertSweepAnchors(git, state.source, { recovery: state.recovery }, {
      line: state.line,
      marker: state.proposal,
      proposal: state.proposal,
    });
    created = await github.createPullRequest({
      title: PROPOSAL_TITLE,
      body: proposalPullRequestBody(state),
      base: recoveryTerminalRef('line').replace('refs/heads/', ''),
      head: recoveryTerminalRef('proposal').replace('refs/heads/', ''),
      draft: true,
    });
    assertSweepAnchors(git, state.source, { recovery: state.recovery }, {
      line: state.line,
      marker: state.proposal,
      proposal: state.proposal,
    });
  } catch (error) {
    postError = error;
    postOutcome = classifyPullRequestPostError(error);
  }

  if (created !== null) {
    try {
      verifyProposalPullRequest(created, state, { requireEditableFields: true });
    } catch (error) {
      postError = error;
      postOutcome = 'ambiguous';
      created = null;
    }
  }
  pulls = await pollProposalHistory(github, git, query, assertState);
  existing = selectSingleHistory(pulls, 'proposal');
  if (existing) {
    const verified = verifyProposalPullRequest(existing, state);
    if (created !== null && verified.number !== created.number) {
      throw new Error('Proposal PR identity changed after successful creation response');
    }
    const action = created !== null
      ? 'created'
      : postOutcome === 'duplicate'
        ? 'reused-after-duplicate-refusal'
        : postOutcome === 'client-rejection'
          ? 'reused-after-client-rejection'
          : 'reused-after-ambiguous-create';
    return { action, pull: verified, markerResult, postOutcome };
  }

  const detail = postError instanceof Error ? postError.message : 'no error detail';
  throw new Error(
    `Proposal PR POST outcome ${postOutcome} has no visible canonical PR; a later exact sweep may retry one POST: ${detail}`,
    postError instanceof Error ? { cause: postError } : undefined,
  );
}

export async function runSweep({ git = new Git(), source, github }) {
  if (!github) throw new Error('A GitHub client is required for sweep mode');
  assertSha(source);
  git.assertTrustedRemote({ requirePush: true });
  git.bindTrustedSource(source);
  const graph = verifyRecoveryGraph(git, createRecoveryGraph(git, source));
  const initialProposal = git.remoteRef(recoveryTerminalRef('proposal'));
  const initialMarker = git.remoteRef(recoveryTerminalRef('pr-attempt'));
  const currentLine = git.remoteRef(recoveryTerminalRef('line'));
  assertSweepAnchors(git, source, graph, { line: currentLine, marker: initialMarker, proposal: initialProposal });
  if (git.remoteRef(recoveryTerminalRef('source')) !== graph.source) throw new Error('Fixed source is not exact trusted main');
  if (initialMarker !== graph.recovery && initialProposal === null) {
    throw new Error('Pre-proposal PR-attempt marker is not exact recovery head');
  }

  const recoveryPulls = await listHistory(
    github,
    git,
    pullQuery('recovery'),
    () => assertSweepAnchors(git, source, graph, { line: currentLine, marker: initialMarker, proposal: initialProposal }),
  );
  const recoveryPull = selectSingleHistory(recoveryPulls, 'recovery');
  if (!recoveryPull) {
    if (currentLine !== graph.source) throw new Error('Recovery PR is absent but fixed line is not source');
    assertProposalStillSuppressed(graph, initialProposal, initialMarker);
    return { mode: 'sweep', outcome: 'blocked-recovery-absent', graph, recoveryPullRequest: null, proposal: null };
  }
  const recoveryHistoryState = verifyRecoveryPullRequest(recoveryPull, git, graph, currentLine);
  assertSweepAnchors(git, source, graph, { line: currentLine, marker: initialMarker, proposal: initialProposal });
  const recoveryDetail = await github.getPullRequest(recoveryPull.number);
  assertSweepAnchors(git, source, graph, { line: currentLine, marker: initialMarker, proposal: initialProposal });
  if (recoveryDetail?.number !== recoveryPull.number) throw new Error('Recovery PR identity changed during hydration');
  const recovery = verifyRecoveryPullRequest(recoveryDetail, git, graph, currentLine);
  if (recovery.status !== recoveryHistoryState.status) {
    throw new Error('Recovery PR state changed during exact history hydration');
  }
  if (recovery.status !== 'merged') {
    assertProposalStillSuppressed(graph, initialProposal, initialMarker);
    return {
      mode: 'sweep',
      outcome: `blocked-recovery-${recovery.status}`,
      graph,
      recoveryPullRequest: { number: recovery.pull.number, status: recovery.status },
      proposal: null,
    };
  }

  const state = {
    source,
    recovery: graph.recovery,
    recoveryNumber: recovery.pull.number,
    line: recovery.line,
  };
  const candidate = verifyProposalCommit(git, createProposalCommit(git, state), state);
  const proposalRef = recoveryTerminalRef('proposal');
  const proposalResult = ensureFixedRef(git, proposalRef, candidate);
  const proposal = git.remoteRef(proposalRef);
  verifyProposalCommit(git, proposal, state);
  const finalState = { ...state, proposal };
  const pull = await ensureProposalPullRequest(github, git, finalState);
  return {
    mode: 'sweep',
    outcome: pull.action === 'created' ? 'proposal-created' : 'proposal-reused',
    graph,
    recoveredLine: recovery.line,
    recoveryPullRequest: { number: recovery.pull.number, status: recovery.status },
    proposal: {
      ref: proposalRef,
      sha: proposal,
      refAction: proposalResult,
      pullAction: pull.action,
      pullNumber: pull.pull.number,
      pullUrl: pull.pull.html_url,
    },
  };
}

export async function runRecoveryTerminal({ mode, git = new Git(), source, github = null }) {
  assertMode(mode);
  return mode === 'setup' ? runSetup({ git, source }) : runSweep({ git, source, github });
}

export function buildSummary(result) {
  const proposal = result.proposal
    ? `- Proposal: \`${result.proposal.ref}\` = \`${result.proposal.sha}\`, PR [#${result.proposal.pullNumber}](${result.proposal.pullUrl})\n`
    : '- Proposal: suppressed; no proposal ref or PR write was authorized by this sweep\n';
  return (
    `## G1 recovery-terminal calibration\n\n` +
    `- Mode: \`${result.mode}\`\n` +
    `- Outcome: \`${result.outcome}\`\n` +
    `- Trusted source: \`${result.graph.source}\`\n` +
    `- Recovery head: \`${result.graph.recovery}\`\n` +
    `- Event: \`${process.env.GITHUB_EVENT_NAME}\`\n` +
    `- Actor: \`${process.env.GITHUB_ACTOR}\`\n` +
    `- Triggering actor: \`${process.env.GITHUB_TRIGGERING_ACTOR}\`\n` +
    `- Permissions used: \`contents: write\`${result.mode === 'sweep' ? ', `pull-requests: write`' : ''}\n` +
    proposal +
    `- Finalization/publication: outside this calibration; remains fablebookjs/infra#19\n`
  );
}

export function finalizeResult(result, {
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  outputPath = process.env.GITHUB_OUTPUT,
  writeStdout = (text) => process.stdout.write(text),
} = {}) {
  const json = JSON.stringify(result, null, 2);
  if (summaryPath) appendFileSync(summaryPath, buildSummary(result));
  if (outputPath) {
    appendFileSync(outputPath, `evidence<<RECOVERY_TERMINAL_EVIDENCE\n${json}\nRECOVERY_TERMINAL_EVIDENCE\noutcome=${result.outcome}\n`);
  }
  writeStdout(`${json}\n`);
  return 0;
}

function assertLiveContext(git) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Wrong GitHub repository');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Wrong GitHub event');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Recovery-terminal calibration must dispatch from main');
  if (git.text(['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA) throw new Error('Checkout is not trusted dispatch SHA');
  git.assertTrustedRemote();
}

async function main() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? null : process.argv[modeIndex + 1];
  assertMode(mode);
  const git = new Git();
  assertLiveContext(git);
  const source = git.text(['rev-parse', 'HEAD']);
  const github = mode === 'sweep' ? new GitHub() : null;
  process.exitCode = finalizeResult(await runRecoveryTerminal({ mode, git, source, github }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
