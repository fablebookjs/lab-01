import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

export const REPOSITORY = 'fablebookjs/lab-01';
export const RELEASE_LINE = 'releases/v1.0';
export const STAGED_LINE = 'staged/v1.0';
export const SNAPSHOT_REF = 'refs/heads/release-snapshots/v1.0.1';
export const BASE_VERSION = '1.0.0';
export const RELEASE_VERSION = '1.0.1';
export const REGISTRY = 'https://registry.npmjs.org/';
export const REPOSITORY_URL = 'git+https://github.com/fablebookjs/lab-01.git';
export const NPM_VERSION = '11.18.0';
export const PACKAGE_SPECS = Object.freeze([
  Object.freeze({
    key: 'Core',
    choice: 'core',
    name: '@fablebook/lab-01-core',
    directory: 'packages/core',
  }),
  Object.freeze({
    key: 'Addon',
    choice: 'addon',
    name: '@fablebook/lab-01-addon',
    directory: 'packages/addon',
  }),
]);
export const TRANSFORMED_FILES = Object.freeze([
  'package-lock.json',
  'package.json',
  'packages/addon/package.json',
  'packages/core/package.json',
]);

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHASUM = /^[0-9a-f]{40}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

export const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

export function assertSha(value, label) {
  if (!SHA.test(value ?? '')) fail(`${label} must be a full lowercase SHA`);
}

const DANGEROUS_GIT_ENVIRONMENT = /^(?:GIT_(?:CONFIG|OBJECT|ALTERNATE|REPLACE|PROXY|SSL|ASKPASS|SSH|CEILING|DISCOVERY|COMMON|DIR|WORK_TREE|INDEX)|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$|CURL_CA_BUNDLE$|SSL_CERT_FILE$)/;

export function assertNoAmbientGitConfiguration(environment = process.env) {
  if (Object.keys(environment).some((key) => DANGEROUS_GIT_ENVIRONMENT.test(key))) fail('AMBIENT_GIT_CONFIG_PROHIBITED');
}

export function closedGitEnvironment(additions = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.RUNNER_TEMP ?? '/tmp',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...additions,
  };
}

export function git(cwd, ...args) {
  const safeArgs = args[0] === '--no-replace-objects' ? args : ['--no-replace-objects', ...args];
  try {
    return execFileSync('git', safeArgs, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: closedGitEnvironment(),
    }).trim();
  } catch {
    fail('GIT_COMMAND_FAILED');
  }
}

export async function command(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    fail(options.errorCode ?? 'SUBPROCESS_FAILED');
  }
}

export function repositoryRemoteIsAllowed(remote) {
  return [
    'git@github.com:fablebookjs/lab-01.git',
    'https://github.com/fablebookjs/lab-01.git',
    'https://github.com/fablebookjs/lab-01',
  ].includes(remote);
}

export function assertSafeGitConfiguration(repoRoot) {
  assertNoAmbientGitConfiguration();
  const remote = git(repoRoot, '--no-replace-objects', 'config', '--local', '--get', 'remote.origin.url');
  if (!repositoryRemoteIsAllowed(remote)) fail(`origin is not the allowlisted ${REPOSITORY} repository`);
  let local = '';
  try { local = git(repoRoot, '--no-replace-objects', 'config', '--local', '--null', '--list'); } catch { fail('GIT_CONFIG_READ_FAILED'); }
  const dangerous = local.split('\0').filter(Boolean).some((entry) =>
    /^(?:remote\..*\.(?:pushurl|proxy|receivepack|uploadpack|tagopt)|core\.(?:hookspath|sshcommand|gitproxy|alternaterefscommand|attributesfile)|credential\.|https?\.|url\.|push\.followtags|include\.|protocol\.|filter\.|submodule\.|extensions\.)/i.test(entry),
  );
  if (dangerous) fail('UNSAFE_GIT_CONFIG');
  const common = git(repoRoot, '--no-replace-objects', 'rev-parse', '--git-common-dir');
  if (existsSync(join(resolve(repoRoot, common), 'objects/info/alternates'))) fail('GIT_ALTERNATES_PROHIBITED');
  if (git(repoRoot, '--no-replace-objects', 'for-each-ref', '--format=%(refname)', 'refs/replace')) fail('GIT_REPLACE_REFS_PROHIBITED');
}

export function commitShape(repoRoot, sha) {
  assertSha(sha, 'commit');
  const row = git(repoRoot, 'rev-list', '--parents', '-n', '1', sha).split(' ');
  return {
    sha,
    parents: row.slice(1),
    tree: git(repoRoot, 'rev-parse', `${sha}^{tree}`),
    message: git(repoRoot, 'show', '-s', '--format=%B', sha),
  };
}

export function readBlob(repoRoot, sha, path) {
  assertSha(sha, 'blob commit');
  try {
    return execFileSync('git', ['--no-replace-objects', 'cat-file', 'blob', `${sha}:${path}`], {
      cwd: repoRoot,
      env: closedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('GIT_BLOB_READ_FAILED');
  }
}

export function exactTreeEntries(repoRoot, sha, directory) {
  const output = git(repoRoot, '--no-replace-objects', 'ls-tree', '-r', sha, '--', directory);
  return output.split('\n').filter(Boolean).map((line) => {
    const match = /^(\d{6}) (blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) fail('GIT_TREE_ENTRY_INVALID');
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
}

export function parseTrailers(message, subject) {
  const lines = message.trimEnd().split('\n');
  if (lines.shift() !== subject) fail(`commit subject is not ${subject}`);
  const trailers = new Map();
  for (const line of lines) {
    if (line === '') continue;
    const match = /^([A-Za-z0-9-]+): (.+)$/.exec(line);
    if (!match || trailers.has(match[1])) fail(`invalid or duplicate commit trailer: ${line}`);
    trailers.set(match[1], match[2]);
  }
  return trailers;
}

export function validateIntentShape(intent, sourceSha) {
  assertSha(sourceSha, 'release source');
  if (intent.parents.length !== 1 || intent.parents[0] !== sourceSha) {
    fail('staged intent does not have the exact release source as its sole parent');
  }
  const sourceTree = intent.sourceTree ?? intent.tree;
  if (intent.tree !== sourceTree) fail('staged intent is not empty');
  const trailers = parseTrailers(intent.message, `release: propose v${RELEASE_VERSION}`);
  const expected = new Map([
    ['Release-Intent-Version', '1'],
    ['Release-Line', RELEASE_LINE],
    ['Release-Version', RELEASE_VERSION],
    ['Release-Source', sourceSha],
  ]);
  if (trailers.size !== expected.size) fail('staged intent has unexpected trailers');
  for (const [key, value] of expected) {
    if (trailers.get(key) !== value) fail(`staged intent has an invalid ${key}`);
  }
}

export function validateMergeShape(merge, source, intent) {
  if (
    new Set([source.sha, intent.sha, merge.sha]).size !== 3 ||
    merge.parents.length !== 2 ||
    merge.parents[0] !== source.sha ||
    merge.parents[1] !== intent.sha ||
    merge.tree !== source.tree ||
    intent.tree !== source.tree
  ) {
    fail('M is not the exact ordered [source, intent] merge with the sealed source tree');
  }
}

export function validateSnapshotShape(snapshot, metadata, merge) {
  if (
    new Set([snapshot.sha, merge.sha, metadata.stagedSha, metadata.sourceSha]).size !== 4 ||
    snapshot.parents.length !== 1 ||
    snapshot.parents[0] !== merge.sha ||
    metadata.mergeSha !== merge.sha ||
    metadata.tree !== snapshot.tree ||
    snapshot.tree === merge.tree
  ) {
    fail('V is not the exact one-parent transformed snapshot over M');
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function validateManifest(manifest, spec, version = RELEASE_VERSION) {
  const expectedKeys = spec.choice === 'core'
    ? ['exports', 'files', 'name', 'repository', 'type', 'version']
    : ['dependencies', 'exports', 'files', 'name', 'repository', 'type', 'version'];
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)) {
    fail(`MANIFEST_KEYS_INVALID_${spec.choice.toUpperCase()}`);
  }
  if (manifest.name !== spec.name || manifest.version !== version || manifest.type !== 'module') {
    fail(`MANIFEST_IDENTITY_INVALID_${spec.choice.toUpperCase()}`);
  }
  if (manifest.exports !== './src/index.js') fail(`MANIFEST_EXPORT_INVALID_${spec.choice.toUpperCase()}`);
  if (JSON.stringify(manifest.files) !== JSON.stringify(['src'])) {
    fail(`MANIFEST_FILES_INVALID_${spec.choice.toUpperCase()}`);
  }
  const expectedRepository = { type: 'git', url: REPOSITORY_URL, directory: spec.directory };
  if (JSON.stringify(manifest.repository) !== JSON.stringify(expectedRepository)) {
    fail(`MANIFEST_REPOSITORY_INVALID_${spec.choice.toUpperCase()}`);
  }
  if ('publishConfig' in manifest || manifest.private === true) {
    fail(`MANIFEST_PUBLICATION_OVERRIDE_${spec.choice.toUpperCase()}`);
  }
}

export async function validateCandidateManifests(candidateDirectory, version = RELEASE_VERSION) {
  const [core, addon] = await Promise.all(
    PACKAGE_SPECS.map((spec) => readJson(join(candidateDirectory, spec.directory, 'package.json'))),
  );
  validateManifest(core, PACKAGE_SPECS[0], version);
  validateManifest(addon, PACKAGE_SPECS[1], version);
  if (addon.dependencies?.[PACKAGE_SPECS[0].name] !== version) {
    fail('ADDON_CORE_DEPENDENCY_INVALID');
  }
  if (Object.keys(addon.dependencies).length !== 1) fail('ADDON_DEPENDENCIES_INVALID');
  return { core, addon };
}

function validateRootManifest(root, version) {
  if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(['devDependencies', 'name', 'private', 'scripts', 'version', 'workspaces'])) {
    fail('ROOT_MANIFEST_KEYS_INVALID');
  }
  if (
    root.name !== '@fablebook/lab-01' || root.version !== version || root.private !== true ||
    JSON.stringify(root.workspaces) !== JSON.stringify(['packages/*']) ||
    JSON.stringify(root.scripts) !== JSON.stringify({
      test: 'node --test test/*.test.mjs',
      'test:qa:e2e': 'node --test test/qa-ready-release.e2e.mjs',
      'qa:ready': 'node scripts/qa-ready-release.mjs',
    }) ||
    JSON.stringify(root.devDependencies) !== JSON.stringify({ verdaccio: '6.8.0' })
  ) fail('ROOT_MANIFEST_INVALID');
}

function validateLockManifest(lock, root, version) {
  if (JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(['lockfileVersion', 'name', 'packages', 'requires', 'version'])) {
    fail('LOCK_KEYS_INVALID');
  }
  const expectedRoot = {
    name: root.name,
    version,
    workspaces: root.workspaces,
    devDependencies: root.devDependencies,
  };
  const expectedAddon = {
    name: PACKAGE_SPECS[1].name,
    version,
    dependencies: { [PACKAGE_SPECS[0].name]: version },
  };
  const expectedCore = { name: PACKAGE_SPECS[0].name, version };
  if (
    lock.name !== root.name || lock.version !== version || lock.lockfileVersion !== 3 || lock.requires !== true ||
    JSON.stringify(lock.packages?.['']) !== JSON.stringify(expectedRoot) ||
    JSON.stringify(lock.packages?.['packages/addon']) !== JSON.stringify(expectedAddon) ||
    JSON.stringify(lock.packages?.['packages/core']) !== JSON.stringify(expectedCore) ||
    JSON.stringify(lock.packages?.[`node_modules/${PACKAGE_SPECS[0].name}`]) !== JSON.stringify({ resolved: 'packages/core', link: true }) ||
    JSON.stringify(lock.packages?.[`node_modules/${PACKAGE_SPECS[1].name}`]) !== JSON.stringify({ resolved: 'packages/addon', link: true })
  ) fail('LOCK_WORKSPACE_SHAPE_INVALID');
}

function gitIndex(repoRoot, indexFile, args, input) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd: repoRoot,
      env: closedGitEnvironment({ GIT_INDEX_FILE: indexFile }),
      input,
      encoding: input === undefined ? 'utf8' : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch {
    fail('GIT_INDEX_OPERATION_FAILED');
  }
}

function transformedContentIdentity(files) {
  const hash = createHash('sha256');
  for (const path of TRANSFORMED_FILES) {
    hash.update(path);
    hash.update('\0');
    hash.update(files.get(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function reconstructExpectedSnapshot(repoRoot, mergeSha, indexFile) {
  const paths = {
    root: 'package.json',
    core: 'packages/core/package.json',
    addon: 'packages/addon/package.json',
    lock: 'package-lock.json',
  };
  const baseline = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, JSON.parse(readBlob(repoRoot, mergeSha, path))]));
  validateRootManifest(baseline.root, BASE_VERSION);
  validateManifest(baseline.core, PACKAGE_SPECS[0], BASE_VERSION);
  validateManifest(baseline.addon, PACKAGE_SPECS[1], BASE_VERSION);
  validateLockManifest(baseline.lock, baseline.root, BASE_VERSION);
  if (baseline.addon.dependencies?.[PACKAGE_SPECS[0].name] !== BASE_VERSION) fail('BASE_ADDON_EDGE_INVALID');
  if (
    baseline.lock.name !== baseline.root.name || baseline.lock.version !== BASE_VERSION || baseline.lock.lockfileVersion !== 3 ||
    baseline.lock.packages?.['']?.version !== BASE_VERSION ||
    baseline.lock.packages?.['packages/core']?.version !== BASE_VERSION ||
    baseline.lock.packages?.['packages/addon']?.version !== BASE_VERSION ||
    baseline.lock.packages?.['packages/addon']?.dependencies?.[PACKAGE_SPECS[0].name] !== BASE_VERSION
  ) fail('BASE_LOCK_INVALID');
  const transformed = structuredClone(baseline);
  transformed.root.version = RELEASE_VERSION;
  transformed.core.version = RELEASE_VERSION;
  transformed.addon.version = RELEASE_VERSION;
  transformed.addon.dependencies[PACKAGE_SPECS[0].name] = RELEASE_VERSION;
  transformed.lock.version = RELEASE_VERSION;
  transformed.lock.packages[''].version = RELEASE_VERSION;
  transformed.lock.packages['packages/core'].version = RELEASE_VERSION;
  transformed.lock.packages['packages/addon'].version = RELEASE_VERSION;
  transformed.lock.packages['packages/addon'].dependencies[PACKAGE_SPECS[0].name] = RELEASE_VERSION;
  validateRootManifest(transformed.root, RELEASE_VERSION);
  validateManifest(transformed.core, PACKAGE_SPECS[0], RELEASE_VERSION);
  validateManifest(transformed.addon, PACKAGE_SPECS[1], RELEASE_VERSION);
  validateLockManifest(transformed.lock, transformed.root, RELEASE_VERSION);
  const files = new Map(Object.entries(paths).map(([key, path]) => [path, Buffer.from(`${JSON.stringify(transformed[key], null, 2)}\n`)]));
  gitIndex(repoRoot, indexFile, ['read-tree', mergeSha]);
  for (const path of TRANSFORMED_FILES) {
    const row = git(repoRoot, 'ls-tree', mergeSha, '--', path);
    if (!/^100644 blob [0-9a-f]{40}\t/.test(row)) fail('TRANSFORM_SOURCE_MODE_INVALID');
    const object = gitIndex(repoRoot, indexFile, ['hash-object', '-w', '--stdin'], files.get(path));
    gitIndex(repoRoot, indexFile, ['update-index', '--add', '--cacheinfo', `100644,${object},${path}`]);
  }
  return {
    tree: gitIndex(repoRoot, indexFile, ['write-tree']),
    contentSha256: transformedContentIdentity(files),
    manifests: { core: transformed.core, addon: transformed.addon },
  };
}

export function validateExactSnapshotTree(repoRoot, mergeSha, snapshotSha, expectedTree) {
  const snapshot = commitShape(repoRoot, snapshotSha);
  if (snapshot.parents.length !== 1 || snapshot.parents[0] !== mergeSha || snapshot.tree !== expectedTree) {
    fail('SNAPSHOT_GRAPH_OR_TREE_INVALID');
  }
  const changes = git(repoRoot, 'diff-tree', '--no-commit-id', '--name-status', '-r', mergeSha, snapshotSha)
    .split('\n').filter(Boolean);
  const expected = TRANSFORMED_FILES.map((path) => `M\t${path}`);
  if (JSON.stringify(changes) !== JSON.stringify(expected)) fail('SNAPSHOT_DIFF_ALLOWLIST_INVALID');
  for (const path of TRANSFORMED_FILES) {
    if (!/^100644 blob [0-9a-f]{40}\t/.test(git(repoRoot, 'ls-tree', snapshotSha, '--', path))) {
      fail('SNAPSHOT_MODE_INVALID');
    }
  }
  return snapshot;
}

export async function materializeInertPackages(repoRoot, snapshotSha, directory) {
  for (const spec of PACKAGE_SPECS) {
    const entries = exactTreeEntries(repoRoot, snapshotSha, spec.directory);
    const expected = [
      { mode: '100644', path: `${spec.directory}/package.json` },
      { mode: '100644', path: `${spec.directory}/src/index.js` },
    ];
    if (
      entries.length !== expected.length ||
      entries.some((entry, index) => entry.mode !== expected[index].mode || entry.type !== 'blob' || entry.path !== expected[index].path)
    ) fail(`PACKAGE_TREE_INVALID_${spec.choice.toUpperCase()}`);
    const packageRoot = join(directory, spec.directory);
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await Promise.all(expected.map(async ({ path }) => {
      const target = join(directory, path);
      await writeFile(target, readBlob(repoRoot, snapshotSha, path), { mode: 0o644 });
    }));
  }
  await validateCandidateManifests(directory);
}

export function assertNoTrackedNpmConfiguration(repoRoot, sha) {
  const paths = git(repoRoot, 'ls-tree', '-r', '--name-only', sha)
    .split('\n')
    .filter((path) => /(?:^|\/)\.npmrc$/i.test(path));
  if (paths.length > 0) fail(`source contains prohibited npm configuration: ${paths.join(', ')}`);
}

export async function createClosedNpmEnvironment(tempRoot, { oidc = false } = {}) {
  const home = join(tempRoot, 'home');
  const cache = join(tempRoot, 'cache');
  const temporary = join(tempRoot, 'tmp');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cache, { recursive: true }), mkdir(temporary, { recursive: true })]);
  const userConfig = join(tempRoot, 'user.npmrc');
  const globalConfig = join(tempRoot, 'global.npmrc');
  await Promise.all([
    writeFile(userConfig, `registry=${REGISTRY}\n@fablebook:registry=${REGISTRY}\nprovenance=true\n`, { mode: 0o600 }),
    writeFile(globalConfig, '', { mode: 0o600 }),
  ]);
  const environment = {
    PATH: process.env.PATH,
    CI: 'true',
    HOME: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_PROVENANCE: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FETCH_RETRIES: '0',
  };
  if (oidc) {
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REPOSITORY !== REPOSITORY ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      !process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/publish-npm.yml@')
    ) {
      fail('GitHub OIDC publication identity is incompatible');
    }
    const githubEnvironment = [
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_ACTIONS',
      'GITHUB_EVENT_NAME',
      'GITHUB_REF',
      'GITHUB_REF_NAME',
      'GITHUB_REPOSITORY',
      'GITHUB_REPOSITORY_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_NUMBER',
      'GITHUB_SHA',
      'GITHUB_WORKFLOW',
      'GITHUB_WORKFLOW_REF',
      'GITHUB_WORKFLOW_SHA',
      'RUNNER_ENVIRONMENT',
    ];
    for (const key of githubEnvironment) {
      if (!process.env[key]) fail(`GitHub OIDC environment is missing ${key}`);
      environment[key] = process.env[key];
    }
  }
  return environment;
}

export async function assertPinnedNpmVersion(tempRoot, { oidc = false } = {}) {
  const environment = await createClosedNpmEnvironment(tempRoot, { oidc });
  const observed = await command('npm', ['--version'], {
    cwd: tempRoot,
    env: environment,
    errorCode: 'NPM_VERSION_READ_FAILED',
  });
  if (observed.stdout !== NPM_VERSION) fail('NPM_VERSION_INVALID');
  return environment;
}

export async function packPackages(candidateDirectory, packDirectory, env) {
  await mkdir(packDirectory, { recursive: true });
  const packages = [];
  for (const spec of PACKAGE_SPECS) {
    const result = await command(
      'npm',
      ['pack', join(candidateDirectory, spec.directory), '--json', '--ignore-scripts', '--pack-destination', packDirectory],
      { cwd: packDirectory, env, errorCode: `NPM_PACK_FAILED_${spec.choice.toUpperCase()}` },
    );
    let output;
    try { output = JSON.parse(result.stdout); } catch { fail(`NPM_PACK_OUTPUT_INVALID_${spec.choice.toUpperCase()}`); }
    if (!Array.isArray(output) || output.length !== 1) fail(`npm pack returned unexpected ${spec.name} output`);
    const item = output[0];
    if (item.name !== spec.name || item.version !== RELEASE_VERSION) fail(`npm pack returned unexpected ${spec.name} identity`);
    const expectedFiles = ['package.json', 'src/index.js'];
    if (JSON.stringify(item.files?.map(({ path }) => path).sort()) !== JSON.stringify(expectedFiles)) {
      fail(`${spec.name} tarball contains unexpected files`);
    }
    const tarball = join(packDirectory, item.filename);
    const bytes = await readFile(tarball);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const shasum = createHash('sha1').update(bytes).digest('hex');
    if (item.integrity !== integrity || item.shasum !== shasum) fail(`${spec.name} npm pack hashes do not match bytes`);
    packages.push({ ...spec, tarball, integrity, shasum, size: bytes.length, files: expectedFiles });
  }
  return packages;
}

export function packageEvidence(packages) {
  return packages.map(({ name, integrity, shasum, size, files }) => ({ name, integrity, shasum, size, files }));
}

export function validatePackageEvidence(packages) {
  if (!Array.isArray(packages) || packages.length !== PACKAGE_SPECS.length) fail('package evidence has an unexpected shape');
  for (let index = 0; index < PACKAGE_SPECS.length; index += 1) {
    const item = packages[index];
    if (
      item.name !== PACKAGE_SPECS[index].name ||
      !INTEGRITY.test(item.integrity ?? '') ||
      !SHASUM.test(item.shasum ?? '')
    ) {
      fail(`package evidence is invalid at position ${index + 1}`);
    }
  }
}

export function validateQaEvidence(evidence, { stagedSha, sourceSha, qaRunId, prNumber }) {
  if (evidence?.schemaVersion !== 2 || evidence.repository !== REPOSITORY) fail('QA evidence schema or repository is incompatible');
  if (
    evidence.authority?.mode !== 'github-current' ||
    evidence.authority.githubCurrent !== true ||
    evidence.authority.repository !== REPOSITORY ||
    evidence.authority.refs?.staged?.name !== STAGED_LINE ||
    evidence.authority.refs?.staged?.sha !== stagedSha ||
    evidence.authority.refs?.source?.name !== RELEASE_LINE ||
    evidence.authority.refs?.source?.sha !== sourceSha ||
    evidence.authority.pullRequest?.number !== Number(prNumber) ||
    evidence.authority.pullRequest?.state !== 'open' ||
    evidence.authority.pullRequest?.head?.sha !== stagedSha ||
    evidence.authority.pullRequest?.head?.repository !== REPOSITORY ||
    evidence.authority.pullRequest?.head?.ref !== STAGED_LINE ||
    evidence.authority.pullRequest?.base?.sha !== sourceSha ||
    evidence.authority.pullRequest?.base?.repository !== REPOSITORY ||
    evidence.authority.pullRequest?.base?.ref !== RELEASE_LINE ||
    evidence.authority.pullRequest?.draft !== false
  ) {
    fail('QA evidence is not current for the sealed release proposal');
  }
  if (
    evidence.release?.version !== RELEASE_VERSION ||
    evidence.release.stagedSha !== stagedSha ||
    evidence.release.sourceSha !== sourceSha ||
    !SHA.test(evidence.release.sourceTree ?? '') ||
    !SHA.test(evidence.release.transformedTree ?? '') ||
    evidence.release.transformedTree === evidence.release.sourceTree ||
    !SHA256.test(evidence.release.transformedContentSha256 ?? '')
  ) {
    fail('QA release evidence is incomplete or incompatible');
  }
  if (
    JSON.stringify(evidence.transformation?.files) !== JSON.stringify(TRANSFORMED_FILES) ||
    JSON.stringify(evidence.transformation?.packageNames) !== JSON.stringify(PACKAGE_SPECS.map(({ name }) => name)) ||
    evidence.transformation?.addonCoreDependency !== RELEASE_VERSION ||
    evidence.consumer?.result !== 'passed'
  ) {
    fail('QA transform or consumer evidence is incompatible');
  }
  const packages = evidence.registry?.packages?.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
  validatePackageEvidence(packages);
  return {
    qaRunId: String(qaRunId),
    sourceTree: evidence.release.sourceTree,
    transformedTree: evidence.release.transformedTree,
    transformedContentSha256: evidence.release.transformedContentSha256,
    packages,
  };
}

export function buildSnapshotMessage({ mergeSha, stagedSha, sourceSha, tree, contentSha256, packages }) {
  validatePackageEvidence(packages);
  assertSha(tree, 'snapshot tree');
  if (!SHA256.test(contentSha256 ?? '')) fail('SNAPSHOT_CONTENT_ID_INVALID');
  const byName = new Map(packages.map((item) => [item.name, item]));
  return `release: snapshot v${RELEASE_VERSION}\n\nRelease-Snapshot-Version: 1\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${RELEASE_VERSION}\nRelease-Merge: ${mergeSha}\nRelease-QA-Staged: ${stagedSha}\nRelease-QA-Source: ${sourceSha}\nRelease-Tree: ${tree}\nRelease-Content-SHA256: ${contentSha256}\nCore-Integrity: ${byName.get(PACKAGE_SPECS[0].name).integrity}\nCore-Shasum: ${byName.get(PACKAGE_SPECS[0].name).shasum}\nAddon-Integrity: ${byName.get(PACKAGE_SPECS[1].name).integrity}\nAddon-Shasum: ${byName.get(PACKAGE_SPECS[1].name).shasum}\n`;
}

export function parseSnapshotMessage(message) {
  const trailers = parseTrailers(message, `release: snapshot v${RELEASE_VERSION}`);
  const required = [
    'Release-Snapshot-Version', 'Release-Line', 'Release-Version', 'Release-Merge',
    'Release-QA-Staged', 'Release-QA-Source', 'Release-Tree', 'Release-Content-SHA256',
    'Core-Integrity', 'Core-Shasum', 'Addon-Integrity', 'Addon-Shasum',
  ];
  if (trailers.size !== required.length || required.some((key) => !trailers.has(key))) fail('snapshot has unexpected metadata');
  const packages = PACKAGE_SPECS.map((spec) => ({
    name: spec.name,
    integrity: trailers.get(`${spec.key}-Integrity`),
    shasum: trailers.get(`${spec.key}-Shasum`),
  }));
  validatePackageEvidence(packages);
  if (
    trailers.get('Release-Snapshot-Version') !== '1' ||
    trailers.get('Release-Line') !== RELEASE_LINE ||
    trailers.get('Release-Version') !== RELEASE_VERSION ||
    !SHA.test(trailers.get('Release-Tree') ?? '') ||
    !SHA256.test(trailers.get('Release-Content-SHA256') ?? '')
  ) fail('snapshot metadata identifies an incompatible release');
  return {
    mergeSha: trailers.get('Release-Merge'),
    stagedSha: trailers.get('Release-QA-Staged'),
    sourceSha: trailers.get('Release-QA-Source'),
    tree: trailers.get('Release-Tree'),
    contentSha256: trailers.get('Release-Content-SHA256'),
    packages,
  };
}

export async function deriveTrustedSnapshotAuthority(repoRoot, snapshotSha, { temporaryBase = tmpdir() } = {}) {
  assertSha(snapshotSha, 'snapshot V');
  const snapshot = commitShape(repoRoot, snapshotSha);
  if (snapshot.parents.length !== 1) fail('SNAPSHOT_PARENT_INVALID');
  const merge = commitShape(repoRoot, snapshot.parents[0]);
  if (merge.parents.length !== 2) fail('MERGE_PARENT_INVALID');
  const source = commitShape(repoRoot, merge.parents[0]);
  const intent = commitShape(repoRoot, merge.parents[1]);
  intent.sourceTree = source.tree;
  validateIntentShape(intent, source.sha);
  validateMergeShape(merge, source, intent);
  assertNoTrackedNpmConfiguration(repoRoot, merge.sha);

  const temporary = await mkdtemp(join(temporaryBase, 'lab-01-snapshot-authority-'));
  try {
    const expected = reconstructExpectedSnapshot(repoRoot, merge.sha, join(temporary, 'index'));
    validateExactSnapshotTree(repoRoot, merge.sha, snapshot.sha, expected.tree);
    const inert = join(temporary, 'inert');
    await materializeInertPackages(repoRoot, snapshot.sha, inert);
    const npmEnvironment = await assertPinnedNpmVersion(join(temporary, 'npm'));
    const packed = packageEvidence(await packPackages(inert, join(temporary, 'packs'), npmEnvironment));
    const packages = packed.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));

    // V metadata is consulted only after S/I/M, the exact transformed whole tree,
    // raw blob materialization, and deterministic tarballs have been derived.
    const metadata = parseSnapshotMessage(snapshot.message);
    validateSnapshotShape(snapshot, metadata, merge);
    if (
      metadata.tree !== expected.tree ||
      metadata.contentSha256 !== expected.contentSha256 ||
      JSON.stringify(metadata.packages) !== JSON.stringify(packages)
    ) fail('SNAPSHOT_METADATA_CROSSCHECK_FAILED');
    return {
      source,
      intent,
      merge,
      snapshot,
      tree: expected.tree,
      contentSha256: expected.contentSha256,
      packages,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function sanitizedEvidence(value) {
  return JSON.parse(JSON.stringify(value));
}
