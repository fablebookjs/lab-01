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
  /^SSH_ASKPASS(?:_REQUIRE)?$/,
  /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i,
  /^SSL_CERT_(?:FILE|DIR)$/,
  /^CURL_CA_BUNDLE$/,
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

  assertTrustedRemote({ requirePush = false } = {}) {
    this.assertNoHostileEnvironment();
    if (this.remote !== 'origin') throw new Error(`Git operations require exact origin, got ${this.remote}`);

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
    if (fetchUrls.length !== 1 || !this.acceptedRemoteUrls.has(fetchUrls[0])) {
      throw new Error(`Untrusted effective origin fetch URL(s): ${fetchUrls.join(', ') || 'none'}`);
    }

    let effectivePushUrls = [];
    if (requirePush) {
      effectivePushUrls = this.text(['remote', 'get-url', '--push', '--all', 'origin'])
        .split('\n')
        .filter(Boolean);
      if (effectivePushUrls.length !== 1 || !this.acceptedRemoteUrls.has(effectivePushUrls[0])) {
        throw new Error(`Untrusted effective origin push URL(s): ${effectivePushUrls.join(', ') || 'none'}`);
      }
    }
    if (requirePush && this.trustedSource !== null) this.assertTrustedSource();
    return { fetchUrl: fetchUrls[0], pushUrl: effectivePushUrls[0] ?? null };
  }

  remoteMain() {
    return this.remoteRef('refs/heads/main', { calibrationOnly: false });
  }

  remoteRef(ref, { calibrationOnly = true } = {}) {
    if (calibrationOnly) assertCalibrationRef(ref);
    else if (ref !== 'refs/heads/main') throw new Error(`Unsupported trusted ref: ${ref}`);
    const output = this.text(['ls-remote', '--heads', this.remote, ref]);
    if (!output) return null;
    const lines = output.split('\n');
    if (lines.length !== 1) throw new Error(`Expected one remote value for ${ref}`);
    const [sha, observedRef] = lines[0].split(/\s+/);
    if (observedRef !== ref) throw new Error(`Malformed remote value for ${ref}`);
    assertSha(sha);
    return sha;
  }

  remoteCalibrationRefs(refs) {
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length !== refs.length || uniqueRefs.length === 0) {
      throw new Error('Remote calibration observation requires unique fixed refs');
    }
    for (const ref of uniqueRefs) assertCalibrationRef(ref);
    const output = this.text(['ls-remote', '--heads', this.remote, ...uniqueRefs]);
    const observed = Object.fromEntries(uniqueRefs.map((ref) => [ref, null]));
    for (const line of output.split('\n').filter(Boolean)) {
      const [sha, ref, extra] = line.split(/\s+/);
      if (!Object.hasOwn(observed, ref) || observed[ref] !== null || extra !== undefined) {
        throw new Error(`Malformed or duplicate remote calibration value for ${ref ?? 'unknown ref'}`);
      }
      assertSha(sha);
      observed[ref] = sha;
    }
    return observed;
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

function observeState(git, graph) {
  const head = git.remoteRef(calibrationRef('head'));
  const approved = git.remoteRef(calibrationRef('approved'));
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
    const before = observeState(git, graph);
    if (before.head !== graph.b) throw new Error('Cannot approve B before calibration head is exact B');
    transition = {
      head: 'retained-b',
      approved: advanceRef(git, calibrationRef('approved'), graph.a, graph.b),
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
