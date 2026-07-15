import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export const fail = (message) => {
  throw new Error(message);
};

export function assertSha(value, label) {
  if (!SHA.test(value ?? '')) fail(`${label} must be a full lowercase SHA`);
}

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${file} ${args.join(' ')} failed: ${detail.slice(-4000)}`, { cause: error });
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
  const remote = git(repoRoot, 'config', '--get', 'remote.origin.url');
  if (!repositoryRemoteIsAllowed(remote)) fail(`origin is not the allowlisted ${REPOSITORY} repository`);
  for (const key of ['remote.origin.pushurl', 'core.hooksPath']) {
    try {
      const value = git(repoRoot, 'config', '--get', key);
      if (value) fail(`unsafe Git configuration ${key} is set`);
    } catch (error) {
      if (error.message.startsWith('unsafe Git configuration')) throw error;
    }
  }
  let rewrites = '';
  try {
    rewrites = git(repoRoot, 'config', '--get-regexp', '^url\\..*\\.insteadof$');
  } catch {
    // No URL rewrites is the safe expected state.
  }
  if (rewrites) fail('unsafe Git URL rewrite configuration is set');
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
    snapshot.tree === merge.tree
  ) {
    fail('V is not the exact one-parent transformed snapshot over M');
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function validateManifest(manifest, spec, version = RELEASE_VERSION) {
  if (manifest.name !== spec.name || manifest.version !== version || manifest.type !== 'module') {
    fail(`unexpected manifest identity for ${spec.name}`);
  }
  if (manifest.exports !== './src/index.js') fail(`${spec.name} has an unexpected export`);
  if (JSON.stringify(manifest.files) !== JSON.stringify(['src'])) {
    fail(`${spec.name} does not have the exact files allowlist`);
  }
  const expectedRepository = { type: 'git', url: REPOSITORY_URL, directory: spec.directory };
  if (JSON.stringify(manifest.repository) !== JSON.stringify(expectedRepository)) {
    fail(`${spec.name} has an incompatible repository identity`);
  }
  if ('publishConfig' in manifest || manifest.private === true) {
    fail(`${spec.name} contains an unsafe publication override`);
  }
}

export async function validateCandidateManifests(candidateDirectory, version = RELEASE_VERSION) {
  const [core, addon] = await Promise.all(
    PACKAGE_SPECS.map((spec) => readJson(join(candidateDirectory, spec.directory, 'package.json'))),
  );
  validateManifest(core, PACKAGE_SPECS[0], version);
  validateManifest(addon, PACKAGE_SPECS[1], version);
  if (addon.dependencies?.[PACKAGE_SPECS[0].name] !== version) {
    fail(`add-on does not depend on exact core ${version}`);
  }
  if (Object.keys(addon.dependencies).length !== 1) fail('add-on has unexpected dependencies');
  return { core, addon };
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

export async function packPackages(candidateDirectory, packDirectory, env) {
  await mkdir(packDirectory, { recursive: true });
  const packages = [];
  for (const spec of PACKAGE_SPECS) {
    const result = await command(
      'npm',
      ['pack', `./${spec.directory}`, '--json', '--ignore-scripts', '--pack-destination', packDirectory],
      { cwd: candidateDirectory, env },
    );
    const output = JSON.parse(result.stdout);
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

export function buildSnapshotMessage({ mergeSha, qaRunId, stagedSha, sourceSha, packages }) {
  validatePackageEvidence(packages);
  const byName = new Map(packages.map((item) => [item.name, item]));
  return `release: snapshot v${RELEASE_VERSION}\n\nRelease-Snapshot-Version: 1\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${RELEASE_VERSION}\nRelease-Merge: ${mergeSha}\nRelease-QA-Run: ${qaRunId}\nRelease-QA-Staged: ${stagedSha}\nRelease-QA-Source: ${sourceSha}\nCore-Integrity: ${byName.get(PACKAGE_SPECS[0].name).integrity}\nCore-Shasum: ${byName.get(PACKAGE_SPECS[0].name).shasum}\nAddon-Integrity: ${byName.get(PACKAGE_SPECS[1].name).integrity}\nAddon-Shasum: ${byName.get(PACKAGE_SPECS[1].name).shasum}\n`;
}

export function parseSnapshotMessage(message) {
  const trailers = parseTrailers(message, `release: snapshot v${RELEASE_VERSION}`);
  const required = [
    'Release-Snapshot-Version', 'Release-Line', 'Release-Version', 'Release-Merge', 'Release-QA-Run',
    'Release-QA-Staged', 'Release-QA-Source', 'Core-Integrity', 'Core-Shasum', 'Addon-Integrity', 'Addon-Shasum',
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
    trailers.get('Release-Version') !== RELEASE_VERSION
  ) fail('snapshot metadata identifies an incompatible release');
  return {
    mergeSha: trailers.get('Release-Merge'),
    qaRunId: trailers.get('Release-QA-Run'),
    stagedSha: trailers.get('Release-QA-Staged'),
    sourceSha: trailers.get('Release-QA-Source'),
    packages,
  };
}

export function sanitizedEvidence(value) {
  return JSON.parse(JSON.stringify(value));
}
