import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { validateIntent } from './maintain-release-draft.mjs';

export const REPOSITORY = 'fablebookjs/lab-01';
export const RELEASE_VERSION = '1.0.1';
export const VERDACCIO_VERSION = '6.8.0';
export const PACKAGE_SPECS = Object.freeze([
  Object.freeze({ name: '@fablebook/lab-01-core', directory: 'packages/core' }),
  Object.freeze({ name: '@fablebook/lab-01-addon', directory: 'packages/addon' }),
]);
export const TRANSFORMED_FILES = Object.freeze([
  'package-lock.json',
  'package.json',
  'packages/addon/package.json',
  'packages/core/package.json',
]);

const BASE_VERSION = '1.0.0';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const execFileAsync = promisify(execFile);

const fail = (message) => {
  throw new Error(message);
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

async function command(commandName, args, options = {}) {
  const started = process.hrtime.bigint();
  try {
    const result = await execFileAsync(commandName, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
    };
  } catch (error) {
    const stderr = error.stderr?.trim();
    const stdout = error.stdout?.trim();
    const detail = stderr || stdout;
    throw new Error(
      `${commandName} ${args.join(' ')} failed${detail ? `: ${detail.slice(-4000)}` : ''}`,
      { cause: error },
    );
  }
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? '')) fail(`${label} must be a full lowercase commit SHA`);
}

function assertExactKeysChanged(before, after, expectedPaths, prefix = '') {
  const changed = [];
  const visit = (left, right, path) => {
    if (Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(path);
      return;
    }
    if (
      left === null ||
      right === null ||
      typeof left !== 'object' ||
      typeof right !== 'object' ||
      Array.isArray(left) ||
      Array.isArray(right)
    ) {
      changed.push(path);
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) visit(left[key], right[key], `${path}/${key}`);
  };
  visit(before, after, prefix);
  if (changed.length !== expectedPaths.length || changed.some((path, i) => path !== expectedPaths[i])) {
    fail(`version transformation changed unexpected fields: ${changed.join(', ')}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertManifestIdentity(root, core, addon, lock) {
  if (root.name !== '@fablebook/lab-01' || root.version !== BASE_VERSION || root.private !== true) {
    fail('root manifest is not the allowlisted 1.0.0 laboratory manifest');
  }
  if (core.name !== PACKAGE_SPECS[0].name || core.version !== BASE_VERSION) {
    fail('core manifest is not the allowlisted 1.0.0 package');
  }
  if (
    addon.name !== PACKAGE_SPECS[1].name ||
    addon.version !== BASE_VERSION ||
    addon.dependencies?.[PACKAGE_SPECS[0].name] !== BASE_VERSION
  ) {
    fail('add-on manifest is not the allowlisted 1.0.0 package with an exact core dependency');
  }
  if (
    lock.name !== root.name ||
    lock.version !== BASE_VERSION ||
    lock.lockfileVersion !== 3 ||
    lock.packages?.['']?.name !== root.name ||
    lock.packages?.['']?.version !== BASE_VERSION ||
    lock.packages?.['packages/core']?.name !== PACKAGE_SPECS[0].name ||
    lock.packages?.['packages/core']?.version !== BASE_VERSION ||
    lock.packages?.['packages/addon']?.name !== PACKAGE_SPECS[1].name ||
    lock.packages?.['packages/addon']?.version !== BASE_VERSION ||
    lock.packages?.['packages/addon']?.dependencies?.[PACKAGE_SPECS[0].name] !== BASE_VERSION
  ) {
    fail('lockfile is not the exact allowlisted 1.0.0 package graph');
  }
}

export async function transformCandidate(candidateDirectory) {
  const paths = {
    root: join(candidateDirectory, 'package.json'),
    core: join(candidateDirectory, 'packages/core/package.json'),
    addon: join(candidateDirectory, 'packages/addon/package.json'),
    lock: join(candidateDirectory, 'package-lock.json'),
  };
  const [root, core, addon, lock] = await Promise.all([
    readJson(paths.root),
    readJson(paths.core),
    readJson(paths.addon),
    readJson(paths.lock),
  ]);
  assertManifestIdentity(root, core, addon, lock);
  const before = { root: clone(root), core: clone(core), addon: clone(addon), lock: clone(lock) };

  root.version = RELEASE_VERSION;
  core.version = RELEASE_VERSION;
  addon.version = RELEASE_VERSION;
  addon.dependencies[PACKAGE_SPECS[0].name] = RELEASE_VERSION;
  lock.version = RELEASE_VERSION;
  lock.packages[''].version = RELEASE_VERSION;
  lock.packages['packages/core'].version = RELEASE_VERSION;
  lock.packages['packages/addon'].version = RELEASE_VERSION;
  lock.packages['packages/addon'].dependencies[PACKAGE_SPECS[0].name] = RELEASE_VERSION;

  assertExactKeysChanged(before.root, root, ['/version']);
  assertExactKeysChanged(before.core, core, ['/version']);
  assertExactKeysChanged(before.addon, addon, [
    `/dependencies/${PACKAGE_SPECS[0].name}`,
    '/version',
  ]);
  assertExactKeysChanged(before.lock, lock, [
    '/packages//version',
    `/packages/packages/addon/dependencies/${PACKAGE_SPECS[0].name}`,
    '/packages/packages/addon/version',
    '/packages/packages/core/version',
    '/version',
  ]);

  await Promise.all([
    writeJson(paths.root, root),
    writeJson(paths.core, core),
    writeJson(paths.addon, addon),
    writeJson(paths.lock, lock),
  ]);
}

export function validateEvidenceBinding(evidence, expected) {
  if (evidence?.schemaVersion !== 1 || evidence.repository !== REPOSITORY) {
    fail('QA evidence has an unexpected schema or repository');
  }
  for (const field of ['stagedSha', 'sourceSha', 'sourceTree', 'transformedTree']) {
    if (evidence.release?.[field] !== expected[field]) {
      fail(`QA evidence ${field} does not match the expected release identity`);
    }
  }
  if (evidence.release.version !== RELEASE_VERSION) fail('QA evidence has an unexpected version');
  if (evidence.release.transformedContentSha256 !== expected.transformedContentSha256) {
    fail('QA evidence transformed content does not match the expected release identity');
  }
  const packages = evidence.registry?.packages;
  if (
    !Array.isArray(packages) ||
    packages.length !== PACKAGE_SPECS.length ||
    packages.some(
      (pkg, index) =>
        pkg.name !== PACKAGE_SPECS[index].name ||
        pkg.version !== RELEASE_VERSION ||
        !INTEGRITY_PATTERN.test(pkg.integrity ?? ''),
    )
  ) {
    fail('QA evidence does not contain exactly the allowlisted package integrities');
  }
  assertLoopbackRegistry(evidence.registry.origin);
  if (
    evidence.consumer?.result !== 'passed' ||
    evidence.consumer?.workspaceResolution !== false ||
    evidence.cleanup?.result !== 'passed'
  ) {
    fail('QA evidence does not prove isolated consumption and cleanup');
  }
}

function assertLoopbackRegistry(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/') {
    fail('registry must be an ephemeral HTTP server bound to 127.0.0.1');
  }
  return url;
}

export function assertRegistryOnlyConsumerLock(lock, registryOrigin, packages) {
  const registry = assertLoopbackRegistry(registryOrigin);
  const expectedNames = PACKAGE_SPECS.map(({ name }) => name);
  const rootDependencies = lock.packages?.['']?.dependencies;
  if (
    Object.keys(rootDependencies ?? {}).sort().join('\n') !== [...expectedNames].sort().join('\n') ||
    expectedNames.some((name) => rootDependencies[name] !== RELEASE_VERSION)
  ) {
    fail('consumer lockfile does not contain exactly the allowlisted exact dependencies');
  }
  for (const pkg of packages) {
    const entry = lock.packages?.[`node_modules/${pkg.name}`];
    if (!entry || entry.version !== RELEASE_VERSION || entry.integrity !== pkg.integrity || entry.link) {
      fail(`consumer lockfile does not bind ${pkg.name} to the verified registry package`);
    }
    if (/^(?:file|link|workspace):/.test(entry.resolved ?? '')) {
      fail(`consumer lockfile resolved ${pkg.name} outside the registry`);
    }
    const resolved = new URL(entry.resolved);
    if (resolved.origin !== registry.origin) {
      fail(`consumer lockfile resolved ${pkg.name} from an unexpected registry`);
    }
  }
  const addon = lock.packages[`node_modules/${PACKAGE_SPECS[1].name}`];
  if (addon.dependencies?.[PACKAGE_SPECS[0].name] !== RELEASE_VERSION) {
    fail('installed add-on does not retain the exact core dependency');
  }
}

export async function withTemporaryDirectory(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateRepository(repoRoot, repository) {
  if (repository !== REPOSITORY) fail(`refusing QA outside ${REPOSITORY}`);
  const remote = git(repoRoot, 'remote', 'get-url', 'origin');
  const accepted = new Set([
    'git@github.com:fablebookjs/lab-01.git',
    'https://github.com/fablebookjs/lab-01.git',
    'https://github.com/fablebookjs/lab-01',
    'ssh://git@github.com/fablebookjs/lab-01.git',
  ]);
  if (!accepted.has(remote)) fail(`origin is not the allowlisted ${REPOSITORY} repository`);
}

function validateStagedIntent(repoRoot, stagedSha, sourceSha) {
  assertSha(stagedSha, 'staged SHA');
  assertSha(sourceSha, 'source SHA');
  const row = git(repoRoot, 'rev-list', '--parents', '-n', '1', stagedSha).split(' ');
  if (row[0] !== stagedSha || row.length !== 2 || row[1] !== sourceSha) {
    fail('staged commit is not a one-parent intent for the exact expected source');
  }
  const commitTree = git(repoRoot, 'rev-parse', `${stagedSha}^{tree}`);
  const sourceTree = git(repoRoot, 'rev-parse', `${sourceSha}^{tree}`);
  validateIntent(
    {
      message: git(repoRoot, 'show', '-s', '--format=%B', stagedSha),
      parents: [sourceSha],
      commitTree,
      parentTree: sourceTree,
    },
    { source: sourceSha },
  );
  return sourceTree;
}

async function transformedContentIdentity(candidateDirectory) {
  const hash = createHash('sha256');
  for (const path of TRANSFORMED_FILES) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(join(candidateDirectory, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function waitForRegistry(origin, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Verdaccio exited before readiness: ${logs.join('').slice(-2000)}`);
    try {
      const response = await fetch(new URL('/-/ping', origin));
      if (response.ok) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail(`Verdaccio did not become ready: ${logs.join('').slice(-2000)}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit').then(() => true);
  let timeout;
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited,
    new Promise((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), 5_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!graceful && child.exitCode === null) {
    const killed = once(child, 'exit');
    child.kill('SIGKILL');
    await killed;
  }
}

function verdaccioConfig(storage, htpasswd) {
  return `storage: ${JSON.stringify(storage)}
auth:
  htpasswd:
    file: ${JSON.stringify(htpasswd)}
    max_users: 1
uplinks: {}
packages:
  '${PACKAGE_SPECS[0].name}':
    access: $all
    publish: $authenticated
    unpublish: $none
  '${PACKAGE_SPECS[1].name}':
    access: $all
    publish: $authenticated
    unpublish: $none
  '**':
    access: $none
    publish: $none
    unpublish: $none
log:
  type: stdout
  format: pretty
  level: warn
`;
}

async function createRegistryToken(origin) {
  const username = 'lab-01-ready-qa';
  const response = await fetch(new URL(`/-/user/org.couchdb.user:${username}`, origin), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _id: `org.couchdb.user:${username}`,
      name: username,
      password: randomBytes(32).toString('base64url'),
      email: 'ready-qa@invalid.example',
      type: 'user',
      roles: [],
      date: new Date(0).toISOString(),
    }),
  });
  const body = await response.json().catch(() => null);
  if (
    !response.ok ||
    body?.ok !== `user '${username}' created` ||
    typeof body.token !== 'string' ||
    body.token.length < 20
  ) {
    fail(`Verdaccio refused the ephemeral QA identity with status ${response.status}`);
  }
  return body.token;
}

async function packCandidate(candidateDirectory, packDirectory, steps, env) {
  const packages = [];
  for (const spec of PACKAGE_SPECS) {
    const packed = await command(
      'npm',
      ['pack', `./${spec.directory}`, '--json', '--pack-destination', packDirectory, '--ignore-scripts'],
      { cwd: candidateDirectory, env },
    );
    steps.push({
      name: `pack:${spec.name}`,
      command: `npm pack ./${spec.directory}`,
      durationMs: packed.durationMs,
    });
    const output = JSON.parse(packed.stdout);
    if (
      output.length !== 1 ||
      output[0].name !== spec.name ||
      output[0].version !== RELEASE_VERSION ||
      !INTEGRITY_PATTERN.test(output[0].integrity ?? '') ||
      !/^[0-9a-f]{40}$/.test(output[0].shasum ?? '')
    ) {
      fail(`npm pack produced an unexpected ${spec.name} candidate`);
    }
    packages.push({
      name: spec.name,
      version: RELEASE_VERSION,
      integrity: output[0].integrity,
      shasum: output[0].shasum,
      tarballPath: join(packDirectory, output[0].filename),
    });
  }
  return packages;
}

async function verifyRegistryPackage(origin, candidate) {
  const metadataUrl = new URL(`/${encodeURIComponent(candidate.name)}/${RELEASE_VERSION}`, origin);
  const response = await fetch(metadataUrl);
  if (!response.ok) fail(`registry metadata for ${candidate.name} returned ${response.status}`);
  const metadata = await response.json();
  if (
    metadata.name !== candidate.name ||
    metadata.version !== RELEASE_VERSION ||
    metadata.dist?.integrity !== candidate.integrity ||
    metadata.dist?.shasum !== candidate.shasum
  ) {
    fail(`registry metadata for ${candidate.name} does not match the packed candidate`);
  }
  const tarballUrl = new URL(metadata.dist.tarball);
  if (tarballUrl.origin !== new URL(origin).origin) {
    fail(`registry tarball for ${candidate.name} escaped the loopback registry`);
  }
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) fail(`registry tarball for ${candidate.name} returned ${tarballResponse.status}`);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (integrity !== candidate.integrity || shasum !== candidate.shasum) {
    fail(`registry tarball for ${candidate.name} failed integrity verification`);
  }
  return {
    name: candidate.name,
    version: RELEASE_VERSION,
    integrity,
    shasum,
    metadataUrl: metadataUrl.href,
    tarballUrl: tarballUrl.href,
  };
}

async function buildIfPresent(candidateDirectory, steps, env) {
  for (const manifestPath of ['package.json', ...PACKAGE_SPECS.map(({ directory }) => `${directory}/package.json`)]) {
    const manifest = await readJson(join(candidateDirectory, manifestPath));
    if (!manifest.scripts?.build) continue;
    const cwd = dirname(join(candidateDirectory, manifestPath));
    const result = await command('npm', ['run', 'build'], { cwd, env });
    steps.push({ name: `build:${manifest.name}`, command: 'npm run build', durationMs: result.durationMs });
  }
}

async function proveConsumer(tempRoot, registryOrigin, registryPackages, steps, repoRoot) {
  const consumerDirectory = join(tempRoot, 'isolated-consumer');
  await mkdir(consumerDirectory);
  const consumerManifest = {
    name: '@fablebook/lab-01-consumer-qa',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node --test consumer.test.mjs' },
    dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
  };
  await Promise.all([
    writeJson(join(consumerDirectory, 'package.json'), consumerManifest),
    copyFile(join(repoRoot, 'consumer/consumer.test.mjs'), join(consumerDirectory, 'consumer.test.mjs')),
  ]);
  const npmEnvironment = {
    ...process.env,
    npm_config_registry: registryOrigin,
    npm_config_cache: join(tempRoot, 'npm-cache'),
    npm_config_userconfig: join(tempRoot, 'npmrc'),
    npm_config_workspaces: 'false',
  };
  await writeFile(
    npmEnvironment.npm_config_userconfig,
    `registry=${registryOrigin}\naudit=false\nfund=false\nupdate-notifier=false\n`,
  );
  const installed = await command(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0'],
    { cwd: consumerDirectory, env: npmEnvironment },
  );
  steps.push({ name: 'consumer:install', command: 'npm install (loopback registry)', durationMs: installed.durationMs });
  const lock = await readJson(join(consumerDirectory, 'package-lock.json'));
  assertRegistryOnlyConsumerLock(lock, registryOrigin, registryPackages);
  for (const { name } of PACKAGE_SPECS) {
    const stats = await lstat(join(consumerDirectory, 'node_modules', name));
    if (stats.isSymbolicLink()) fail(`isolated consumer linked ${name} instead of installing a tarball`);
  }
  const tested = await command('npm', ['test'], { cwd: consumerDirectory, env: npmEnvironment });
  steps.push({ name: 'consumer:test', command: 'npm test', durationMs: tested.durationMs });
  const rootPath = await realpath(repoRoot);
  const consumerPath = await realpath(consumerDirectory);
  if (consumerPath === rootPath || consumerPath.startsWith(`${rootPath}${sep}`)) {
    fail('consumer directory is inside the repository workspace');
  }
}

export async function runReadyReleaseQa({ repository, stagedSha, sourceSha, repoRoot }) {
  validateRepository(repoRoot, repository);
  const sourceTree = validateStagedIntent(repoRoot, stagedSha, sourceSha);
  const tempRoot = await mkdtemp(join(tmpdir(), 'fablebook-lab-01-ready-qa-'));
  const candidateDirectory = join(tempRoot, 'candidate');
  const packDirectory = join(tempRoot, 'packs');
  const storageDirectory = join(tempRoot, 'verdaccio-storage');
  const steps = [];
  const qaNpmEnvironment = {
    ...process.env,
    npm_config_cache: join(tempRoot, 'npm-cache'),
    npm_config_userconfig: join(tempRoot, 'npm-tooling.npmrc'),
  };
  let worktreeAdded = false;
  let verdaccio;
  let evidence;
  try {
    git(repoRoot, 'worktree', 'add', '--detach', candidateDirectory, sourceSha);
    worktreeAdded = true;
    if (git(candidateDirectory, 'status', '--porcelain') !== '') fail('candidate worktree is not clean');
    await transformCandidate(candidateDirectory);
    const changedFiles = git(candidateDirectory, 'diff', '--name-only').split('\n').filter(Boolean).sort();
    if (changedFiles.join('\n') !== TRANSFORMED_FILES.join('\n')) {
      fail(`candidate changed outside the allowlist: ${changedFiles.join(', ')}`);
    }
    git(candidateDirectory, 'add', '--', ...TRANSFORMED_FILES);
    const stagedFiles = git(candidateDirectory, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
    if (stagedFiles.join('\n') !== TRANSFORMED_FILES.join('\n')) {
      fail('candidate index does not contain exactly the allowlisted transformation');
    }
    const transformedTree = git(candidateDirectory, 'write-tree');
    const transformedContentSha256 = await transformedContentIdentity(candidateDirectory);

    await writeFile(qaNpmEnvironment.npm_config_userconfig, 'audit=false\nfund=false\nupdate-notifier=false\n');
    const installed = await command(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: candidateDirectory, env: qaNpmEnvironment },
    );
    steps.push({ name: 'candidate:install', command: 'npm ci', durationMs: installed.durationMs });
    const tested = await command('npm', ['test'], {
      cwd: candidateDirectory,
      env: { ...qaNpmEnvironment, LAB_01_EXPECTED_PACKAGE_VERSION: RELEASE_VERSION },
    });
    steps.push({
      name: 'candidate:test',
      command: 'LAB_01_EXPECTED_PACKAGE_VERSION=1.0.1 npm test',
      durationMs: tested.durationMs,
    });
    await buildIfPresent(candidateDirectory, steps, qaNpmEnvironment);

    await mkdir(packDirectory);
    const packedPackages = await packCandidate(candidateDirectory, packDirectory, steps, qaNpmEnvironment);
    await mkdir(storageDirectory);
    const configPath = join(tempRoot, 'verdaccio.yaml');
    await writeFile(configPath, verdaccioConfig(storageDirectory, join(tempRoot, 'htpasswd')));
    const port = await reserveLoopbackPort();
    const registryOrigin = `http://127.0.0.1:${port}/`;
    assertLoopbackRegistry(registryOrigin);
    const logs = [];
    const verdaccioBinary = join(repoRoot, 'node_modules/.bin/verdaccio');
    await access(verdaccioBinary);
    verdaccio = spawn(verdaccioBinary, ['--config', configPath, '--listen', `127.0.0.1:${port}`], {
      cwd: tempRoot,
      env: { ...process.env, NODE_ENV: 'production', VERDACCIO_HANDLE_KILL_SIGNALS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [verdaccio.stdout, verdaccio.stderr]) {
      stream.on('data', (chunk) => {
        logs.push(chunk.toString());
        if (logs.length > 200) logs.shift();
      });
    }
    await waitForRegistry(registryOrigin, verdaccio, logs);
    const registryToken = await createRegistryToken(registryOrigin);

    const npmEnvironment = {
      ...process.env,
      npm_config_registry: registryOrigin,
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_userconfig: join(tempRoot, 'npmrc'),
    };
    await writeFile(
      npmEnvironment.npm_config_userconfig,
      `registry=${registryOrigin}\n//127.0.0.1:${port}/:_authToken=${registryToken}\naudit=false\nfund=false\nupdate-notifier=false\n`,
    );
    for (const pkg of packedPackages) {
      if (!PACKAGE_SPECS.some(({ name }) => name === pkg.name)) fail('refusing to publish a non-allowlisted package');
      const published = await command(
        'npm',
        [
          'publish',
          pkg.tarballPath,
          '--registry',
          registryOrigin,
          '--access',
          'public',
          '--ignore-scripts',
          '--provenance=false',
        ],
        { cwd: tempRoot, env: npmEnvironment },
      );
      steps.push({ name: `publish:${pkg.name}`, command: 'npm publish (loopback registry)', durationMs: published.durationMs });
    }
    const registryPackages = [];
    for (const pkg of packedPackages) registryPackages.push(await verifyRegistryPackage(registryOrigin, pkg));
    await proveConsumer(tempRoot, registryOrigin, registryPackages, steps, repoRoot);

    evidence = {
      schemaVersion: 1,
      repository: REPOSITORY,
      release: {
        version: RELEASE_VERSION,
        stagedSha,
        sourceSha,
        sourceTree,
        transformedTree,
        transformedContentSha256,
      },
      transformation: {
        files: [...TRANSFORMED_FILES],
        packageNames: PACKAGE_SPECS.map(({ name }) => name),
        addonCoreDependency: RELEASE_VERSION,
      },
      registry: {
        implementation: `verdaccio@${VERDACCIO_VERSION}`,
        origin: registryOrigin,
        loopbackOnly: true,
        packages: registryPackages,
      },
      consumer: {
        dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
        directoryOutsideRepository: true,
        workspaceResolution: false,
        result: 'passed',
      },
      steps,
    };
  } finally {
    const cleanupErrors = [];
    try {
      await stopProcess(verdaccio);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (worktreeAdded) {
        git(repoRoot, 'worktree', 'remove', '--force', candidateDirectory);
        git(repoRoot, 'worktree', 'prune');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'ready release QA cleanup failed');
  }
  try {
    await access(tempRoot);
    fail('temporary QA directory survived cleanup');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (git(repoRoot, 'worktree', 'list', '--porcelain').includes(candidateDirectory)) {
    fail('temporary candidate worktree survived cleanup');
  }
  evidence.cleanup = {
    result: 'passed',
    registryStopped: true,
    temporaryWorktreeRemoved: true,
    registryStateRemoved: true,
  };
  validateEvidenceBinding(evidence, evidence.release);
  return evidence;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--repository', '--staged-sha', '--source-sha', '--evidence'].includes(key) || !value) {
      fail(`unknown or incomplete argument: ${key ?? '<missing>'}`);
    }
    values[key.slice(2)] = value;
  }
  for (const key of ['repository', 'staged-sha', 'source-sha', 'evidence']) {
    if (!values[key]) fail(`--${key} is required`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const evidence = await runReadyReleaseQa({
    repository: args.repository,
    stagedSha: args['staged-sha'],
    sourceSha: args['source-sha'],
    repoRoot,
  });
  const output = resolve(args.evidence);
  await mkdir(dirname(output), { recursive: true });
  await writeJson(output, evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
