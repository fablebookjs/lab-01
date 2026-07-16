import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  access,
  appendFile,
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
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { validateIntent } from './maintain-release-draft.mjs';
import { assertSafeGitConfiguration, closedGitEnvironment } from './release-publication.mjs';

export const REPOSITORY = 'fablebookjs/lab-01';
export const RELEASE_VERSION = '1.0.1';
export const VERDACCIO_VERSION = '6.8.0';
export const RELEASE_LINE = 'releases/v1.0';
export const STAGED_LINE = 'staged/v1.0';
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHASUM_PATTERN = /^[0-9a-f]{40}$/;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const execFileAsync = promisify(execFile);
const READY_QA_SIGNAL = 'Ready release QA signal';
const HISTORY_PAGE_SIZE = 100;
const HISTORY_MAX_PAGES = 20;

const fail = (message) => {
  throw new Error(message);
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd,
      encoding: 'utf8',
      env: closedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail('QA_GIT_OPERATION_FAILED');
  }
};

export async function command(commandName, args, options = {}) {
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
  } catch {
    fail('QA_SUBPROCESS_FAILED');
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

export function localAuthority() {
  return {
    mode: 'local',
    githubCurrent: false,
    repository: REPOSITORY,
    event: 'local',
    refs: null,
    pullRequest: null,
  };
}

function transformationContract() {
  return {
    files: [...TRANSFORMED_FILES],
    packageNames: PACKAGE_SPECS.map(({ name }) => name),
    addonCoreDependency: RELEASE_VERSION,
  };
}

function cleanupContract() {
  return {
    result: 'passed',
    registryStopped: true,
    temporaryWorktreeRemoved: true,
    registryStateRemoved: true,
    credentialStateRemoved: true,
    consumerStateRemoved: true,
    npmCacheRemoved: true,
  };
}

function expectedStepShape(steps) {
  const prefix = [
    ['candidate:install', 'npm ci --omit=dev --offline (loopback registry)'],
  ];
  const suffix = [
    [`pack:${PACKAGE_SPECS[0].name}`, `npm pack ./${PACKAGE_SPECS[0].directory}`],
    [`pack:${PACKAGE_SPECS[1].name}`, `npm pack ./${PACKAGE_SPECS[1].directory}`],
    [`publish:${PACKAGE_SPECS[0].name}`, 'npm publish (loopback registry)'],
    [`publish:${PACKAGE_SPECS[1].name}`, 'npm publish (loopback registry)'],
    ['consumer:install', 'npm install (loopback registry)'],
    ['consumer:test', 'npm test'],
  ];
  const commands = [...prefix, ...suffix];
  if (
    !Array.isArray(steps) ||
    steps.length !== commands.length ||
    steps.some(
      (step, index) =>
        step?.name !== commands[index][0] ||
        step.command !== commands[index][1] ||
        !Number.isInteger(step.durationMs) ||
        step.durationMs < 0 ||
        Object.keys(step).sort().join('\n') !== ['command', 'durationMs', 'name'].join('\n'),
    )
  ) {
    fail('QA evidence steps do not match the exact lab command contract');
  }
}

function assertAuthorityContract(authority, stagedSha, sourceSha) {
  if (authority?.mode === 'local') {
    if (!isDeepStrictEqual(authority, localAuthority())) {
      fail('local QA authority has unexpected or GitHub-current fields');
    }
    return;
  }
  if (
    authority?.mode !== 'github-current' ||
    authority.githubCurrent !== true ||
    authority.repository !== REPOSITORY ||
    !['pull_request', 'workflow_dispatch'].includes(authority.event) ||
    authority.refs?.staged?.name !== STAGED_LINE ||
    authority.refs.staged.sha !== stagedSha ||
    authority.refs?.source?.name !== RELEASE_LINE ||
    authority.refs.source.sha !== sourceSha ||
    authority.pullRequest?.state !== 'open' ||
    authority.pullRequest.draft !== false ||
    !Number.isInteger(authority.pullRequest.number) ||
    authority.pullRequest.number < 1 ||
    authority.pullRequest.head?.repository !== REPOSITORY ||
    authority.pullRequest.head.ref !== STAGED_LINE ||
    authority.pullRequest.head.sha !== stagedSha ||
    authority.pullRequest.base?.repository !== REPOSITORY ||
    authority.pullRequest.base.ref !== RELEASE_LINE ||
    authority.pullRequest.base.sha !== sourceSha
  ) {
    fail('GitHub QA authority is not the exact current release PR and refs');
  }
  const expectedKeys = ['event', 'githubCurrent', 'mode', 'pullRequest', 'refs', 'repository'];
  if (Object.keys(authority).sort().join('\n') !== expectedKeys.sort().join('\n')) {
    fail('GitHub QA authority has unexpected fields');
  }
  if (
    Object.keys(authority.refs).sort().join('\n') !== ['source', 'staged'].join('\n') ||
    Object.keys(authority.refs.staged).sort().join('\n') !== ['name', 'sha'].join('\n') ||
    Object.keys(authority.refs.source).sort().join('\n') !== ['name', 'sha'].join('\n') ||
    Object.keys(authority.pullRequest).sort().join('\n') !==
      ['base', 'draft', 'head', 'number', 'state'].join('\n') ||
    Object.keys(authority.pullRequest.head).sort().join('\n') !==
      ['ref', 'repository', 'sha'].join('\n') ||
    Object.keys(authority.pullRequest.base).sort().join('\n') !==
      ['ref', 'repository', 'sha'].join('\n')
  ) {
    fail('GitHub QA authority has unexpected nested fields');
  }
}

export function buildExpectedEvidenceContract({
  authority,
  stagedSha,
  sourceSha,
  sourceTree,
  transformedTree,
  transformedContentSha256,
  registryOrigin,
  packages,
  steps,
}) {
  return {
    schemaVersion: 2,
    repository: REPOSITORY,
    authority: clone(authority),
    release: {
      version: RELEASE_VERSION,
      stagedSha,
      sourceSha,
      sourceTree,
      transformedTree,
      transformedContentSha256,
    },
    transformation: transformationContract(),
    registry: {
      implementation: { name: 'verdaccio', version: VERDACCIO_VERSION },
      origin: registryOrigin,
      loopbackOnly: true,
      noUplinks: true,
      authenticatedPublish: true,
      allowedPackages: PACKAGE_SPECS.map(({ name }) => name),
      packages: clone(packages),
    },
    consumer: {
      name: '@fablebook/lab-01-consumer-qa',
      location: 'temporary-outside-repository',
      directoryOutsideRepository: true,
      dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
      registryOrigin,
      lockfileResolution: 'registry-only',
      workspaceResolution: false,
      result: 'passed',
    },
    steps: clone(steps),
    cleanup: cleanupContract(),
  };
}

function assertEvidenceContract(contract) {
  if (contract?.schemaVersion !== 2 || contract.repository !== REPOSITORY) {
    fail('QA evidence has an unexpected schema or repository');
  }
  const release = contract.release;
  for (const field of ['stagedSha', 'sourceSha', 'sourceTree', 'transformedTree']) {
    assertSha(release?.[field], `evidence ${field}`);
  }
  if (release.version !== RELEASE_VERSION || !SHA256_PATTERN.test(release.transformedContentSha256 ?? '')) {
    fail('QA evidence release identity is malformed');
  }
  if (
    Object.keys(release).sort().join('\n') !==
    [
      'sourceSha',
      'sourceTree',
      'stagedSha',
      'transformedContentSha256',
      'transformedTree',
      'version',
    ].join('\n')
  ) {
    fail('QA evidence release identity has unexpected fields');
  }
  assertAuthorityContract(contract.authority, release.stagedSha, release.sourceSha);
  if (!isDeepStrictEqual(contract.transformation, transformationContract())) {
    fail('QA evidence transformation contract is not exact');
  }
  const registry = assertLoopbackRegistry(contract.registry?.origin);
  if (
    !isDeepStrictEqual(contract.registry.implementation, {
      name: 'verdaccio',
      version: VERDACCIO_VERSION,
    }) ||
    contract.registry.loopbackOnly !== true ||
    contract.registry.noUplinks !== true ||
    contract.registry.authenticatedPublish !== true ||
    !isDeepStrictEqual(
      contract.registry.allowedPackages,
      PACKAGE_SPECS.map(({ name }) => name),
    ) ||
    !Array.isArray(contract.registry.packages) ||
    contract.registry.packages.length !== PACKAGE_SPECS.length ||
    Object.keys(contract.registry).sort().join('\n') !==
      [
        'allowedPackages',
        'authenticatedPublish',
        'implementation',
        'loopbackOnly',
        'noUplinks',
        'origin',
        'packages',
      ].join('\n')
  ) {
    fail('QA evidence registry contract is not exact');
  }
  for (const [index, pkg] of contract.registry.packages.entries()) {
    const spec = PACKAGE_SPECS[index];
    const expectedMetadata = new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, registry);
    const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
    const expectedTarball = new URL(`/${spec.name}/-/${archiveName}`, registry);
    if (
      pkg?.name !== spec.name ||
      pkg.version !== RELEASE_VERSION ||
      !INTEGRITY_PATTERN.test(pkg.integrity ?? '') ||
      !SHASUM_PATTERN.test(pkg.shasum ?? '') ||
      pkg.metadataUrl !== expectedMetadata.href ||
      pkg.tarballUrl !== expectedTarball.href ||
      Object.keys(pkg).sort().join('\n') !==
        ['integrity', 'metadataUrl', 'name', 'shasum', 'tarballUrl', 'version'].sort().join('\n')
    ) {
      fail(`QA evidence package contract is invalid for ${spec.name}`);
    }
  }
  const expectedConsumer = {
    name: '@fablebook/lab-01-consumer-qa',
    location: 'temporary-outside-repository',
    directoryOutsideRepository: true,
    dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
    registryOrigin: registry.href,
    lockfileResolution: 'registry-only',
    workspaceResolution: false,
    result: 'passed',
  };
  if (!isDeepStrictEqual(contract.consumer, expectedConsumer)) {
    fail('QA evidence consumer contract is not exact');
  }
  expectedStepShape(contract.steps);
  if (!isDeepStrictEqual(contract.cleanup, cleanupContract())) {
    fail('QA evidence cleanup contract is not exact');
  }
  const topLevelKeys = [
    'authority',
    'cleanup',
    'consumer',
    'registry',
    'release',
    'repository',
    'schemaVersion',
    'steps',
    'transformation',
  ];
  if (Object.keys(contract).sort().join('\n') !== topLevelKeys.sort().join('\n')) {
    fail('QA evidence has unexpected top-level fields');
  }
}

export function validateEvidenceBinding(evidence, expected) {
  assertEvidenceContract(expected);
  assertEvidenceContract(evidence);
  if (!isDeepStrictEqual(evidence, expected)) {
    fail('QA evidence does not exactly match independently derived runtime facts');
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

function closedSubprocessEnvironment(tempRoot, additions = {}) {
  if (!process.env.PATH) fail('PATH is required to run the pinned local QA tooling');
  const home = join(tempRoot, 'isolated-home');
  const temporary = join(tempRoot, 'subprocess-tmp');
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    CI: 'true',
    NO_COLOR: '1',
    ...additions,
  };
}

export async function createIsolatedNpmEnvironment({
  tempRoot,
  name,
  registryOrigin,
  token,
  workspaces,
  additions = {},
}) {
  assertLoopbackRegistry(registryOrigin);
  if (!/^[a-z][a-z0-9-]+$/.test(name)) fail('isolated npm environment name is invalid');
  for (const key of Object.keys(additions)) {
    if (/(?:npm|registry|proxy|token|auth|userconfig|globalconfig)/i.test(key)) {
      fail(`refusing unsafe npm environment addition: ${key}`);
    }
  }
  const configDirectory = join(tempRoot, 'npm-config', name);
  const cache = join(tempRoot, 'npm-cache', name);
  await Promise.all([
    mkdir(configDirectory, { recursive: true }),
    mkdir(cache, { recursive: true }),
    mkdir(join(tempRoot, 'isolated-home'), { recursive: true }),
    mkdir(join(tempRoot, 'subprocess-tmp'), { recursive: true }),
  ]);
  const userConfig = join(configDirectory, 'user.npmrc');
  const globalConfig = join(configDirectory, 'global.npmrc');
  const registry = new URL(registryOrigin);
  const lines = [
    `registry=${registry.href}`,
    `@fablebook:registry=${registry.href}`,
    'audit=false',
    'fund=false',
    'update-notifier=false',
    'fetch-retries=0',
  ];
  if (token) lines.push(`//127.0.0.1:${registry.port}/:_authToken=${token}`);
  await Promise.all([writeFile(userConfig, `${lines.join('\n')}\n`), writeFile(globalConfig, '')]);
  return closedSubprocessEnvironment(tempRoot, {
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_REGISTRY: registry.href,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FETCH_RETRIES: '0',
    ...(workspaces === undefined ? {} : { NPM_CONFIG_WORKSPACES: String(workspaces) }),
    ...additions,
  });
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

function pullShape(pull) {
  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    head: {
      repository: pull.head?.repo?.full_name,
      ref: pull.head?.ref,
      sha: pull.head?.sha,
    },
    base: {
      repository: pull.base?.repo?.full_name,
      ref: pull.base?.ref,
      sha: pull.base?.sha,
    },
  };
}

function isAuthoritativePull(pull) {
  return (
    pull.state === 'open' &&
    pull.draft === false &&
    pull.head?.repo?.full_name === REPOSITORY &&
    pull.head?.ref === STAGED_LINE &&
    pull.base?.repo?.full_name === REPOSITORY &&
    pull.base?.ref === RELEASE_LINE
  );
}

function validActor(actor) {
  return Number.isInteger(actor?.id) && actor.id > 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(actor.login ?? '');
}

export function validateReadyQaWakeup({ eventName, event }) {
  if (event?.repository?.full_name !== REPOSITORY || !Number.isInteger(event.repository.id) || event.repository.id < 1) {
    fail('Ready QA wake-up repository identity is invalid');
  }
  if (!validActor(event.sender)) fail('Ready QA wake-up sender identity is invalid');
  if (eventName === 'workflow_dispatch') {
    if (event.inputs && Object.keys(event.inputs).length !== 0) fail('manual Ready QA wake-up cannot supply state');
    return { event: eventName, actor: event.sender.login };
  }
  if (eventName !== 'workflow_run' || event.action !== 'completed') fail('Ready QA event is not an allowed wake-up');
  const run = event.workflow_run;
  if (
    !Number.isInteger(run?.id) || run.id < 1 ||
    run.name !== READY_QA_SIGNAL ||
    run.event !== 'pull_request' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== STAGED_LINE ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    !validActor(run.actor) ||
    !validActor(run.triggering_actor)
  ) {
    fail('Ready QA signal wake-up identity is invalid');
  }
  return { event: eventName, actor: run.triggering_actor.login, runId: run.id };
}

export function validateGitHubAuthoritySnapshot({
  eventName,
  event,
  stagedRefSha,
  sourceRefSha,
  pulls,
  localHead,
  mainRefSha,
  expectedDispatchSha,
  expectedWorkflowSha,
}) {
  assertSha(stagedRefSha, 'current staged ref SHA');
  assertSha(sourceRefSha, 'current release ref SHA');
  assertSha(localHead, 'checked-out trusted main SHA');
  assertSha(mainRefSha, 'current main ref SHA');
  if (event?.repository?.full_name !== REPOSITORY) fail('GitHub event repository is not the laboratory');
  validateReadyQaWakeup({ eventName, event });
  if (
    localHead !== mainRefSha || expectedDispatchSha !== mainRefSha || expectedWorkflowSha !== mainRefSha
  ) fail('checked-out QA controller is not exact current trusted main');
  const matching = pulls.filter(isAuthoritativePull);
  if (matching.length !== 1) {
    fail(`expected exactly one current authoritative ready release PR, found ${matching.length}`);
  }
  const pull = matching[0];
  if (pull.head.sha !== stagedRefSha || pull.base.sha !== sourceRefSha) {
    fail('authoritative PR head/base do not equal the current staged/release refs');
  }
  return {
    mode: 'github-current',
    githubCurrent: true,
    repository: REPOSITORY,
    event: eventName,
    refs: {
      staged: { name: STAGED_LINE, sha: stagedRefSha },
      source: { name: RELEASE_LINE, sha: sourceRefSha },
    },
    pullRequest: pullShape(pull),
  };
}

async function githubGet(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) fail(`read-only GitHub API GET ${path} failed with ${response.status}`);
  return body;
}

function canonicalReadyPulls(pulls) {
  return pulls.map((pull) => ({
    id: pull.id,
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    head: { repository: pull.head?.repo?.full_name, ref: pull.head?.ref, sha: pull.head?.sha },
    base: { repository: pull.base?.repo?.full_name, ref: pull.base?.ref, sha: pull.base?.sha },
  })).sort((left, right) => left.number - right.number);
}

async function readReadyPullSweep(token) {
  const pulls = [];
  const numbers = new Set();
  const ids = new Set();
  for (let page = 1; page <= HISTORY_MAX_PAGES; page += 1) {
    const batch = await githubGet(
      `/repos/${REPOSITORY}/pulls?state=open&base=${encodeURIComponent(RELEASE_LINE)}&per_page=${HISTORY_PAGE_SIZE}&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length > HISTORY_PAGE_SIZE) fail('Ready QA PR history page is invalid');
    for (const pull of batch) {
      if (!Number.isInteger(pull?.number) || pull.number < 1 || numbers.has(pull.number) || !Number.isInteger(pull.id) || pull.id < 1 || ids.has(pull.id)) {
        fail('Ready QA PR history has duplicate or malformed identity');
      }
      numbers.add(pull.number);
      ids.add(pull.id);
      pulls.push(pull);
    }
    if (batch.length < HISTORY_PAGE_SIZE) return pulls;
  }
  fail('Ready QA PR history exceeded its explicit bound');
}

async function readStableReadyPulls(token) {
  const first = await readReadyPullSweep(token);
  const second = await readReadyPullSweep(token);
  if (JSON.stringify(canonicalReadyPulls(first)) !== JSON.stringify(canonicalReadyPulls(second))) {
    fail('Ready QA PR history moved across complete sweeps');
  }
  return second;
}

function remoteBranchSha(repoRoot, branch) {
  const output = git(repoRoot, 'ls-remote', '--refs', '--exit-code', 'origin', `refs/heads/${branch}`);
  const rows = output.split('\n').filter(Boolean);
  if (rows.length !== 1) fail(`remote ${branch} ref is not unique`);
  const [sha, ref, extra] = rows[0].split(/\s+/);
  assertSha(sha, `remote ${branch}`);
  if (extra !== undefined || ref !== `refs/heads/${branch}`) fail(`remote ${branch} ref is malformed`);
  return sha;
}

function fetchCandidateObjects(repoRoot, shas) {
  git(repoRoot, 'fetch', '--force', '--no-tags', '--no-write-fetch-head', 'origin', ...shas);
}

async function resolveGitHubAuthority({ repoRoot, eventName, eventPath, token }) {
  if (!token) fail('read-only GITHUB_TOKEN is required for GitHub-current QA authority');
  const event = await readJson(eventPath);
  validateReadyQaWakeup({ eventName, event });
  const mainRefSha = remoteBranchSha(repoRoot, 'main');
  const stagedRefSha = remoteBranchSha(repoRoot, STAGED_LINE);
  const sourceRefSha = remoteBranchSha(repoRoot, RELEASE_LINE);
  const pulls = await readStableReadyPulls(token);
  const authority = validateGitHubAuthoritySnapshot({
    eventName,
    event,
    stagedRefSha,
    sourceRefSha,
    pulls,
    localHead: git(repoRoot, 'rev-parse', 'HEAD'),
    mainRefSha,
    expectedDispatchSha: process.env.EXPECTED_DISPATCH_SHA,
    expectedWorkflowSha: process.env.EXPECTED_WORKFLOW_SHA,
  });
  fetchCandidateObjects(repoRoot, [stagedRefSha, sourceRefSha]);
  return { authority, stagedSha: stagedRefSha, sourceSha: sourceRefSha };
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
    if (child.exitCode !== null) fail('QA_REGISTRY_EXITED_BEFORE_READY');
    try {
      const response = await fetch(new URL('/-/ping', origin));
      if (response.ok) return;
    } catch {
      // The loopback listener is not ready yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail('QA_REGISTRY_READY_TIMEOUT');
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
    const tarballPath = join(packDirectory, output[0].filename);
    const packedBytes = await readFile(tarballPath);
    const integrity = `sha512-${createHash('sha512').update(packedBytes).digest('base64')}`;
    const shasum = createHash('sha1').update(packedBytes).digest('hex');
    if (output[0].integrity !== integrity || output[0].shasum !== shasum) {
      fail(`npm pack hashes do not match the packed bytes for ${spec.name}`);
    }
    packages.push({
      name: spec.name,
      version: RELEASE_VERSION,
      integrity,
      shasum,
      tarballPath,
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
  const archiveName = `${candidate.name.slice(candidate.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
  const expectedTarballUrl = new URL(`/${candidate.name}/-/${archiveName}`, origin);
  if (tarballUrl.href !== expectedTarballUrl.href) {
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
  const npmEnvironment = await createIsolatedNpmEnvironment({
    tempRoot,
    name: 'consumer',
    registryOrigin,
    workspaces: false,
  });
  const installed = await command(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--fetch-retries=0',
      '--workspaces=false',
      '--registry',
      registryOrigin,
    ],
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

export async function runReadyReleaseQa({
  repository,
  stagedSha,
  sourceSha,
  repoRoot,
  authority,
  testHooks = {},
}) {
  assertSafeGitConfiguration(repoRoot);
  validateRepository(repoRoot, repository);
  assertAuthorityContract(authority, stagedSha, sourceSha);
  const sourceTree = validateStagedIntent(repoRoot, stagedSha, sourceSha);
  const npmConfigurationPaths = git(repoRoot, 'ls-tree', '-r', '--name-only', sourceSha)
    .split('\n')
    .filter((path) => /(?:^|\/)\.npmrc$/i.test(path));
  if (npmConfigurationPaths.length > 0) {
    fail(`candidate source contains prohibited npm configuration: ${npmConfigurationPaths.join(', ')}`);
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'fablebook-lab-01-ready-qa-'));
  const candidateDirectory = join(tempRoot, 'candidate');
  const packDirectory = join(tempRoot, 'packs');
  const storageDirectory = join(tempRoot, 'verdaccio-storage');
  const steps = [];
  let worktreeAdded = false;
  let verdaccio;
  let evidence;
  let transformedTree;
  let transformedContentSha256;
  let registryOrigin;
  let registryPackages;
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
    transformedTree = git(candidateDirectory, 'write-tree');
    transformedContentSha256 = await transformedContentIdentity(candidateDirectory);

    await Promise.all([
      mkdir(packDirectory),
      mkdir(storageDirectory),
      mkdir(join(tempRoot, 'isolated-home')),
      mkdir(join(tempRoot, 'subprocess-tmp')),
    ]);
    const configPath = join(tempRoot, 'verdaccio.yaml');
    await writeFile(configPath, verdaccioConfig(storageDirectory, join(tempRoot, 'htpasswd')));
    const port = await reserveLoopbackPort();
    registryOrigin = `http://127.0.0.1:${port}/`;
    assertLoopbackRegistry(registryOrigin);
    const logs = [];
    const trustedToolRoot = process.env.LAB_01_TRUSTED_TOOL_ROOT || repoRoot;
    const verdaccioBinary = join(trustedToolRoot, 'node_modules/.bin/verdaccio');
    await access(verdaccioBinary);
    verdaccio = spawn(verdaccioBinary, ['--config', configPath, '--listen', `127.0.0.1:${port}`], {
      cwd: tempRoot,
      env: closedSubprocessEnvironment(tempRoot, {
        NODE_ENV: 'production',
        VERDACCIO_HANDLE_KILL_SIGNALS: 'true',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [verdaccio.stdout, verdaccio.stderr]) {
      stream.on('data', (chunk) => {
        logs.push(chunk.toString());
        if (logs.length > 200) logs.shift();
      });
    }
    await waitForRegistry(registryOrigin, verdaccio, logs);
    if (testHooks.afterRegistryReady) await testHooks.afterRegistryReady();

    const candidateNpmEnvironment = await createIsolatedNpmEnvironment({
      tempRoot,
      name: 'candidate',
      registryOrigin,
    });
    const installed = await command(
      'npm',
      [
        'ci',
        '--omit=dev',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--fetch-retries=0',
        '--workspaces=true',
        '--registry',
        registryOrigin,
      ],
      { cwd: candidateDirectory, env: candidateNpmEnvironment },
    );
    steps.push({
      name: 'candidate:install',
      command: 'npm ci --omit=dev --offline (loopback registry)',
      durationMs: installed.durationMs,
    });
    const packedPackages = await packCandidate(
      candidateDirectory,
      packDirectory,
      steps,
      candidateNpmEnvironment,
    );
    const registryToken = await createRegistryToken(registryOrigin);
    const publisherNpmEnvironment = await createIsolatedNpmEnvironment({
      tempRoot,
      name: 'publisher',
      registryOrigin,
      token: registryToken,
    });
    for (const pkg of packedPackages) {
      if (!PACKAGE_SPECS.some(({ name }) => name === pkg.name)) {
        fail('refusing to publish a non-allowlisted package');
      }
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
        { cwd: tempRoot, env: publisherNpmEnvironment },
      );
      steps.push({
        name: `publish:${pkg.name}`,
        command: 'npm publish (loopback registry)',
        durationMs: published.durationMs,
      });
    }
    registryPackages = [];
    for (const pkg of packedPackages) {
      registryPackages.push(await verifyRegistryPackage(registryOrigin, pkg));
    }
    await proveConsumer(tempRoot, registryOrigin, registryPackages, steps, repoRoot);

    evidence = {
      schemaVersion: 2,
      repository: REPOSITORY,
      authority: clone(authority),
      release: {
        version: RELEASE_VERSION,
        stagedSha,
        sourceSha,
        sourceTree,
        transformedTree,
        transformedContentSha256,
      },
      transformation: transformationContract(),
      registry: {
        implementation: { name: 'verdaccio', version: VERDACCIO_VERSION },
        origin: registryOrigin,
        loopbackOnly: true,
        noUplinks: true,
        authenticatedPublish: true,
        allowedPackages: PACKAGE_SPECS.map(({ name }) => name),
        packages: clone(registryPackages),
      },
      consumer: {
        name: '@fablebook/lab-01-consumer-qa',
        location: 'temporary-outside-repository',
        directoryOutsideRepository: true,
        dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
        registryOrigin,
        lockfileResolution: 'registry-only',
        workspaceResolution: false,
        result: 'passed',
      },
      steps: clone(steps),
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
  evidence.cleanup = cleanupContract();
  const expectedEvidence = buildExpectedEvidenceContract({
    authority,
    stagedSha,
    sourceSha,
    sourceTree,
    transformedTree,
    transformedContentSha256,
    registryOrigin,
    packages: registryPackages,
    steps,
  });
  validateEvidenceBinding(evidence, expectedEvidence);
  return evidence;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        '--authority',
        '--repository',
        '--staged-sha',
        '--source-sha',
        '--event-name',
        '--event-path',
        '--evidence',
      ].includes(key) ||
      !value ||
      values[key.slice(2)]
    ) {
      fail(`unknown or incomplete argument: ${key ?? '<missing>'}`);
    }
    values[key.slice(2)] = value;
  }
  for (const key of ['authority', 'repository', 'evidence']) {
    if (!values[key]) fail(`--${key} is required`);
  }
  if (values.authority === 'local') {
    for (const key of ['staged-sha', 'source-sha']) {
      if (!values[key]) fail(`--${key} is required for explicit local authority`);
    }
    if (values['event-name'] || values['event-path']) {
      fail('local authority cannot accept GitHub event inputs');
    }
  } else if (values.authority === 'github-current') {
    for (const key of ['event-name', 'event-path']) {
      if (!values[key]) fail(`--${key} is required for GitHub-current authority`);
    }
    if (values['staged-sha'] || values['source-sha']) {
      fail('GitHub-current authority derives SHAs and cannot accept caller-supplied SHAs');
    }
  } else {
    fail('--authority must be exactly local or github-current');
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const output = resolve(args.evidence);
  await mkdir(dirname(output), { recursive: true });
  try {
    const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
    assertSafeGitConfiguration(repoRoot);
    const resolved =
      args.authority === 'local'
        ? {
            authority: localAuthority(),
            stagedSha: args['staged-sha'],
            sourceSha: args['source-sha'],
          }
        : await resolveGitHubAuthority({
            repoRoot,
            eventName: args['event-name'],
            eventPath: args['event-path'],
            token: process.env.GITHUB_TOKEN,
          });
    const evidence = await runReadyReleaseQa({
      repository: args.repository,
      stagedSha: resolved.stagedSha,
      sourceSha: resolved.sourceSha,
      repoRoot,
      authority: resolved.authority,
    });
    await writeJson(output, evidence);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `staged_sha=${resolved.stagedSha}\n`);
    }
    console.log(JSON.stringify(evidence, null, 2));
  } catch {
    await writeJson(output, {
      schemaVersion: 2,
      repository: REPOSITORY,
      operation: 'ready-release-qa',
      status: 'failed',
      error: { code: 'READY_QA_FAILED' },
    });
    fail('READY_QA_FAILED');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
