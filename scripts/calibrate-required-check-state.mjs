import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'fablebookjs/lab-01';
export const NAMESPACE = 'refs/heads/calibration/g1/required-check';
export const FILE_PATH = 'calibration/g1/required-check/state.txt';
export const MODES = ['setup', 'advance-head', 'approve-head'];
export const ROLES = ['base', 'a', 'b', 'head', 'approved'];

const REF_SET = new Set(ROLES.map((role) => `${NAMESPACE}/${role}`));
const GRAPH_ROLES = ['base', 'a', 'b'];
const LIVE_REMOTE_URLS = [
  'https://github.com/fablebookjs/lab-01',
  'https://github.com/fablebookjs/lab-01.git',
];
const A_CONTENT = 'required-check calibration A\n';
const B_CONTENT = 'required-check calibration B\n';
const NULL_DEVICE = '/dev/null';
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
const SAFE_AUTH_CONFIG = new Set([
  'http.https://github.com/.extraheader',
  'http.https://github.com/fablebookjs/lab-01.extraheader',
  'http.https://github.com/fablebookjs/lab-01.git.extraheader',
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
  /^GIT_WORK_TREE$/,
  /^GCM_/,
  /^SSH_ASKPASS(?:_REQUIRE)?$/,
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^CURL_/,
  /^NETRC$/i,
];

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Fablebook Required Check Calibration',
  GIT_AUTHOR_EMAIL: 'lab-required-check@fablebook.invalid',
  GIT_AUTHOR_DATE: '2026-07-15T16:00:00Z',
  GIT_COMMITTER_NAME: 'Fablebook Required Check Calibration',
  GIT_COMMITTER_EMAIL: 'lab-required-check@fablebook.invalid',
  GIT_COMMITTER_DATE: '2026-07-15T16:00:00Z',
};

export function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid commit identity: ${sha}`);
}

export class Git {
  constructor({ cwd = process.cwd(), remote = 'origin', acceptedRemoteUrls = LIVE_REMOTE_URLS } = {}) {
    this.cwd = cwd;
    this.remote = remote;
    this.acceptedRemoteUrls = new Set(acceptedRemoteUrls);
    this.trustedSource = null;
  }

  hostileEnvironmentKeys() {
    return Object.keys(process.env).filter((key) =>
      HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)),
    );
  }

  assertNoHostileEnvironment() {
    const hostile = this.hostileEnvironmentKeys();
    if (hostile.length > 0) {
      throw new Error(`Hostile inherited Git environment: ${hostile.sort().join(', ')}`);
    }
  }

  run(args, { env = {}, input, allowFailure = false } = {}) {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !HOSTILE_GIT_ENVIRONMENT.some((pattern) => pattern.test(key)),
      ),
    );
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
      },
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

  localConfigEntries() {
    const result = this.run(['config', '--local', '--null', '--get-regexp', '.*'], {
      allowFailure: true,
    });
    if (result.status === 1 && !result.stdout) return [];
    if (result.status !== 0) {
      throw new Error(`Could not audit repository Git config: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split('\0')
      .filter(Boolean)
      .map((record) => {
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
      if (SAFE_AUTH_CONFIG.has(key)) {
        if (!/^AUTHORIZATION: basic [A-Za-z0-9+/=]+$/i.test(value)) {
          throw new Error(`Unsafe repository Git config: ${key}`);
        }
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
          .includes(key) &&
        !['true', 'false'].includes(value.toLowerCase())
      ) {
        throw new Error(`Unsafe repository Git config: ${key}`);
      } else if (key === 'gc.auto' && value !== '0') {
        throw new Error('Unsafe repository Git config: gc.auto');
      }
    }
    if (counts.get('remote.origin.url') !== 1 || originUrl === null) {
      throw new Error('Repository must have one exact origin URL');
    }
    for (const key of SAFE_AUTH_CONFIG) {
      if ((counts.get(key) ?? 0) > 1) throw new Error(`Duplicate scoped checkout authentication: ${key}`);
    }
    const authCount = [...SAFE_AUTH_CONFIG].reduce((total, key) => total + (counts.get(key) ?? 0), 0);
    if (authCount > 1) throw new Error('Only one scoped checkout authentication entry is allowed');
    return { originUrl };
  }

  assertTrustedRemote({ requirePush = false } = {}) {
    this.assertNoHostileEnvironment();
    if (this.remote !== 'origin') throw new Error(`Git operations require exact origin, got ${this.remote}`);
    const { originUrl } = this.assertSafeLocalConfig();
    if (requirePush && this.trustedSource !== null) this.assertTrustedSource();
    return { fetchUrl: originUrl, pushUrl: requirePush ? originUrl : null };
  }

  remoteMain() {
    return this.remoteRef('refs/heads/main', { calibrationOnly: false });
  }

  remoteRef(ref, { calibrationOnly = true } = {}) {
    if (calibrationOnly) assertCalibrationRef(ref);
    else if (ref !== 'refs/heads/main') throw new Error(`Unsupported trusted ref: ${ref}`);
    this.assertTrustedRemote();
    const output = this.text(['ls-remote', '--heads', this.remote, ref]);
    return parseRemoteAdvertisement(output, [ref])[ref];
  }

  remoteCalibrationRefs(refs) {
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length !== refs.length || uniqueRefs.length === 0) {
      throw new Error('Remote calibration observation requires unique fixed refs');
    }
    for (const ref of uniqueRefs) assertCalibrationRef(ref);
    this.assertTrustedRemote();
    const output = this.text(['ls-remote', '--heads', this.remote, ...uniqueRefs]);
    return parseRemoteAdvertisement(output, uniqueRefs);
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
    if (localHead !== this.trustedSource) {
      throw new Error(`Local HEAD ${localHead} is not trusted source ${this.trustedSource}`);
    }
    const remote = this.remoteMain();
    if (remote !== this.trustedSource) {
      throw new Error(`Remote refs/heads/main ${remote ?? 'absent'} is not trusted source ${this.trustedSource}`);
    }
    return this.trustedSource;
  }
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

export function calibrationRef(role) {
  if (!ROLES.includes(role)) throw new Error(`Unsupported required-check calibration role: ${role}`);
  return `${NAMESPACE}/${role}`;
}

export function assertCalibrationRef(ref) {
  if (!REF_SET.has(ref)) {
    throw new Error(`Ref is outside the exact required-check calibration namespace: ${ref}`);
  }
}

function assertMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`Unsupported required-check calibration mode: ${mode}`);
}

export function pushWithLease(git, ref, expected, next) {
  assertCalibrationRef(ref);
  if (expected !== null) assertSha(expected);
  assertSha(next);
  git.assertTrustedRemote({ requirePush: true });
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

export function pushAtomicApproval(git, graph) {
  const headRef = calibrationRef('head');
  const approvedRef = calibrationRef('approved');
  for (const sha of [graph.a, graph.b]) assertSha(sha);
  git.assertTrustedRemote({ requirePush: true });
  return git.run(
    [
      'push',
      '--porcelain',
      '--atomic',
      '--no-follow-tags',
      `--force-with-lease=${headRef}:${graph.b}`,
      `--force-with-lease=${approvedRef}:${graph.a}`,
      git.remote,
      `${graph.b}:${headRef}`,
      `${graph.b}:${approvedRef}`,
    ],
    { allowFailure: true },
  );
}

function isExactStaleLeaseRejection(push, ref, candidate) {
  const exact = `!\t${candidate}:${ref}\t[rejected] (stale info)`;
  return push.status !== 0 && push.stdout.split('\n').includes(exact);
}

function ensureFixedRef(git, ref, sha) {
  const observed = git.remoteRef(ref);
  if (observed === sha) return 'reused';
  if (observed !== null) throw new Error(`Fixed calibration ref ${ref} is ${observed}, expected ${sha}`);
  const push = pushWithLease(git, ref, null, sha);
  if (push.status !== 0) {
    const winner = git.remoteRef(ref);
    if (winner === sha) return 'reused-race-winner';
    throw new Error(`Could not create ${ref} at ${sha}: ${push.stderr.trim() || push.stdout.trim()}`);
  }
  if (git.remoteRef(ref) !== sha) throw new Error(`Remote verification failed for ${ref}`);
  return 'created';
}

function advanceRef(git, ref, expected, next) {
  const observed = git.remoteRef(ref);
  if (observed === next) return 'reused';
  if (observed !== expected) {
    throw new Error(`Calibration state ${ref} is ${observed ?? 'absent'}, expected ${expected}`);
  }
  const push = pushWithLease(git, ref, expected, next);
  if (push.status !== 0) {
    const winner = git.remoteRef(ref);
    if (winner === next && isExactStaleLeaseRejection(push, ref, next)) return 'advanced-lost-success';
    throw new Error(
      `Guarded update of ${ref} was rejected; observed ${winner ?? 'absent'}: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
  if (git.remoteRef(ref) !== next) throw new Error(`Remote verification failed for ${ref}`);
  return 'advanced';
}

function commitTree(git, tree, parent, message) {
  return git.text(['commit-tree', tree, '-p', parent], { env: COMMIT_ENV, input: `${message}\n` });
}

function treeWithFile(git, base, content) {
  const root = mkdtempSync(join(tmpdir(), 'lab-01-required-check-index-'));
  const index = join(root, 'index');
  try {
    const env = { GIT_INDEX_FILE: index };
    git.run(['read-tree', `${base}^{tree}`], { env });
    const blob = git.text(['hash-object', '-w', '--stdin'], { input: content });
    git.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${FILE_PATH}`], { env });
    return git.text(['write-tree'], { env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parent(git, sha) {
  return git.text(['show', '-s', '--format=%P', sha]);
}

function tree(git, sha) {
  return git.text(['show', '-s', '--format=%T', sha]);
}

function verifyFile(git, sha, content, role) {
  const output = git.text(['ls-tree', sha, '--', FILE_PATH]);
  const [metadata, path, extra] = output.split('\t');
  const [mode, type, blob, extraMetadata] = (metadata ?? '').split(' ');
  const expectedBlob = git.text(['hash-object', '--stdin'], { input: content });
  if (
    mode !== '100644' ||
    type !== 'blob' ||
    blob !== expectedBlob ||
    path !== FILE_PATH ||
    extra !== undefined ||
    extraMetadata !== undefined
  ) {
    throw new Error(`${role} is not the canonical fixed calibration file`);
  }
}

export function createGraph(git, source) {
  assertSha(source);
  git.run(['cat-file', '-e', `${source}^{commit}`]);
  const sourceTree = tree(git, source);
  const base = commitTree(git, sourceTree, source, 'required-check calibration base');
  const a = commitTree(git, treeWithFile(git, base, A_CONTENT), base, 'required-check calibration A');
  const b = commitTree(git, treeWithFile(git, a, B_CONTENT), a, 'required-check calibration B');
  return { source, base, a, b };
}

export function verifyGraph(git, graph) {
  for (const sha of Object.values(graph)) {
    assertSha(sha);
    git.run(['cat-file', '-e', `${sha}^{commit}`]);
  }
  if (parent(git, graph.base) !== graph.source || tree(git, graph.base) !== tree(git, graph.source)) {
    throw new Error('Calibration base is not one empty commit over trusted source');
  }
  if (parent(git, graph.a) !== graph.base) throw new Error('A parent is not exact base');
  if (parent(git, graph.b) !== graph.a) throw new Error('B parent is not exact A');
  verifyFile(git, graph.a, A_CONTENT, 'A');
  verifyFile(git, graph.b, B_CONTENT, 'B');
  const aPaths = git.text(['diff-tree', '--no-commit-id', '--name-only', '-r', graph.base, graph.a]);
  const bPaths = git.text(['diff-tree', '--no-commit-id', '--name-only', '-r', graph.a, graph.b]);
  if (aPaths !== FILE_PATH || bPaths !== FILE_PATH) throw new Error('A or B changes outside the fixed path');
  return graph;
}

function requireGraphRefs(git, graph, { create }) {
  const results = {};
  for (const role of GRAPH_ROLES) {
    if (create) results[role] = ensureFixedRef(git, calibrationRef(role), graph[role]);
    else {
      const observed = git.remoteRef(calibrationRef(role));
      if (observed !== graph[role]) {
        throw new Error(`Fixed ${role.toUpperCase()} ref is ${observed ?? 'absent'}, expected ${graph[role]}`);
      }
      results[role] = 'verified';
    }
  }
  return results;
}

function readState(git) {
  const headRef = calibrationRef('head');
  const approvedRef = calibrationRef('approved');
  const observed = git.remoteCalibrationRefs([headRef, approvedRef]);
  return { head: observed[headRef], approved: observed[approvedRef] };
}

function observeState(git, graph) {
  const { head, approved } = readState(git);
  if (![graph.a, graph.b].includes(head)) {
    throw new Error(`Calibration head is ${head ?? 'absent'}, expected exact A or B`);
  }
  if (![graph.a, graph.b].includes(approved)) {
    throw new Error(`Calibration approval is ${approved ?? 'absent'}, expected exact A or B`);
  }
  if (head === graph.a && approved === graph.b) {
    throw new Error('Calibration approval cannot advance to B before head');
  }
  return { head, approved };
}

function approveHead(git, graph) {
  const before = observeState(git, graph);
  if (before.head !== graph.b) throw new Error('Cannot approve B before calibration head is exact B');
  if (before.approved === graph.b) return 'reused';
  const push = pushAtomicApproval(git, graph);
  const after = readState(git);
  if (push.status !== 0) {
    if (after.head === graph.b && after.approved === graph.b) return 'approved-lost-success';
    throw new Error(
      `Atomic approval was rejected; head=${after.head ?? 'absent'}, approved=${after.approved ?? 'absent'}: ` +
        `${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
  if (after.head !== graph.b || after.approved !== graph.b) {
    throw new Error(
      `Atomic approval verification failed; head=${after.head ?? 'absent'}, approved=${after.approved ?? 'absent'}`,
    );
  }
  return 'advanced';
}

export function runStateCalibration({ mode, git = new Git(), source }) {
  assertMode(mode);
  assertSha(source);
  git.assertNoHostileEnvironment();
  git.assertTrustedRemote({ requirePush: true });
  git.bindTrustedSource(source);
  const graph = verifyGraph(git, createGraph(git, source));
  const graphRefs = requireGraphRefs(git, graph, { create: mode === 'setup' });
  let transition;

  if (mode === 'setup') {
    const head = git.remoteRef(calibrationRef('head'));
    const approved = git.remoteRef(calibrationRef('approved'));
    const headResult = head === null
      ? ensureFixedRef(git, calibrationRef('head'), graph.a)
      : [graph.a, graph.b].includes(head)
        ? 'reused'
        : (() => { throw new Error(`Unexpected retained head ${head}`); })();
    const approvedResult = approved === null
      ? ensureFixedRef(git, calibrationRef('approved'), graph.a)
      : [graph.a, graph.b].includes(approved)
        ? 'reused'
        : (() => { throw new Error(`Unexpected retained approval ${approved}`); })();
    transition = { head: headResult, approved: approvedResult };
  } else if (mode === 'advance-head') {
    const before = observeState(git, graph);
    transition = {
      head: advanceRef(git, calibrationRef('head'), graph.a, graph.b),
      approved: before.approved === graph.a ? 'retained-a' : 'retained-b',
    };
  } else {
    transition = {
      head: 'retained-b',
      approved: approveHead(git, graph),
    };
  }

  const state = observeState(git, graph);
  git.assertTrustedSource();
  return { mode, graph, graphRefs, transition, state };
}

function buildSummary(result) {
  return (
    `## G1 required-check state calibration\n\n` +
    `- Mode: \`${result.mode}\`\n` +
    `- Base: \`${result.graph.base}\`\n` +
    `- A: \`${result.graph.a}\`\n` +
    `- B: \`${result.graph.b}\`\n` +
    `- Remote head: \`${result.state.head}\`\n` +
    `- Remote approved: \`${result.state.approved}\`\n` +
    `- Permission used: \`contents: write\` only\n`
  );
}

function assertLiveContext(git) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Live calibration runs only in GitHub Actions');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Wrong GitHub repository');
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Wrong GitHub event');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('State calibration must dispatch from main');
  if (git.text(['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA) {
    throw new Error('Checked-out commit is not the trusted dispatch SHA');
  }
}

async function main() {
  const git = new Git();
  git.assertNoHostileEnvironment();
  assertLiveContext(git);
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? null : process.argv[modeIndex + 1];
  const source = git.text(['rev-parse', 'HEAD']);
  const result = runStateCalibration({ mode, git, source });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, buildSummary(result));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
