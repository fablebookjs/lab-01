import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const BOOTSTRAP = Object.freeze({
  repository: 'fablebookjs/lab-01',
  remoteUrls: Object.freeze([
    'git@github.com:fablebookjs/lab-01.git',
    'https://github.com/fablebookjs/lab-01.git',
  ]),
  tag: 'v1.0.0',
  commit: 'b59edf1d4c0fff51295327e8ce9e72678c336156',
  tree: 'c17e4b63e8fd8b0bff28e1b9e24caa203d29d80e',
  registry: 'https://registry.npmjs.org/',
  packages: Object.freeze([
    Object.freeze({
      name: '@fablebook/lab-01-core',
      version: '1.0.0',
      path: 'packages/core',
      integrity:
        'sha512-D2/F0PkQoENQagqntg1tUB0zn8lOen0jnqvyw0sbRLN3fkMJ4OR60geERuANxq0Ihx0RlCoYoP1lQhzb2KQZ+g==',
      shasum: '8ff5241867ebd1c2747c23ea016342c7cd101f6d',
    }),
    Object.freeze({
      name: '@fablebook/lab-01-addon',
      version: '1.0.0',
      path: 'packages/addon',
      integrity:
        'sha512-DssrVgnRMbPG5qVqt0yr43ImplnR2YJZyCZkr0Yvp5h+wJHo5x9qL2Svpo3GyruuMZm1zdIhKJPAYYmZe7m78g==',
      shasum: '5ccab401d844a0254bd1914b5b96d798462a5017',
    }),
  ]),
});

export const CONFIRMATION =
  'publish @fablebook/lab-01-core@1.0.0 then @fablebook/lab-01-addon@1.0.0';

const TERMINATION_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const SIGNAL_NUMBERS = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 });
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHASUM_PATTERN = /^[0-9a-f]{40}$/;
const privateErrorFacts = new WeakMap();

const CHILD_CLASSIFICATIONS = new Set(['not-found', 'duplicate', 'ambiguous']);

class BootstrapError extends Error {
  constructor(message, { code = 'BOOTSTRAP_FAILED', classification } = {}) {
    super(message);
    this.name = 'BootstrapError';
    this.safeToReport = true;
    this.code = code;
    if (CHILD_CLASSIFICATIONS.has(classification)) this.classification = classification;
    privateErrorFacts.set(this, {
      kind: 'bootstrap',
      message,
      code,
      classification: this.classification,
    });
  }
}

export class BootstrapInterrupted extends Error {
  constructor(signal, phase) {
    super(`bootstrap interrupted by ${signal}`);
    this.name = 'BootstrapInterrupted';
    this.signal = signal;
    this.phase = phase ?? 'between-operations';
    this.exitCode = 128 + SIGNAL_NUMBERS[signal];
    this.safeToReport = true;
    privateErrorFacts.set(this, { kind: 'interruption', signal, phase: this.phase });
  }
}

const fail = (message, code) => {
  throw new BootstrapError(message, { code });
};

function sanitizeBoundaryError(error) {
  const facts = privateErrorFacts.get(error);
  if (facts?.kind === 'interruption') {
    return new BootstrapInterrupted(facts.signal, facts.phase);
  }
  if (facts?.kind === 'bootstrap') {
    return new BootstrapError(facts.message, {
      code: facts.code,
      classification: facts.classification,
    });
  }
  return new BootstrapError('bootstrap failed at a private boundary', {
    code: 'PRIVATE_BOUNDARY_FAILURE',
    classification: 'ambiguous',
  });
}

const hashesEqual = (left, right) =>
  left?.integrity === right?.integrity && left?.shasum === right?.shasum;

export function hashBytes(bytes) {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

export async function hashTarball(path) {
  return hashBytes(await readFile(path));
}

class SignalController {
  constructor({ processObject = process, graceMilliseconds = 2_000 } = {}) {
    this.processObject = processObject;
    this.graceMilliseconds = graceMilliseconds;
    this.active = null;
    this.interruption = null;
    this.handlers = new Map();
    this.abortController = new AbortController();
  }

  install() {
    for (const signal of TERMINATION_SIGNALS) {
      const handler = () => this.interrupt(signal);
      this.handlers.set(signal, handler);
      this.processObject.on(signal, handler);
    }
  }

  dispose() {
    for (const [signal, handler] of this.handlers) {
      this.processObject.off(signal, handler);
    }
    this.handlers.clear();
    if (this.active?.timer) clearTimeout(this.active.timer);
  }

  interrupt(signal) {
    if (this.interruption) return;
    const phase = this.active?.phase ?? 'between-operations';
    this.interruption = new BootstrapInterrupted(signal, phase);
    this.abortController.abort(this.interruption);
    if (this.active) this.forward(this.active, signal);
  }

  forward(active, signal) {
    const { child } = active;
    if (child.exitCode !== null || child.signalCode !== null) return;
    let forwarded = false;
    if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, signal);
        forwarded = true;
      } catch {
        // Fall back to the direct child when process-group signalling is unavailable.
      }
    }
    if (!forwarded) child.kill(signal);
    active.timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall back to the direct child.
        }
      }
      child.kill('SIGKILL');
    }, this.graceMilliseconds);
    active.timer.unref();
  }

  attach(child, phase) {
    if (this.active) fail('bootstrap attempted overlapping subprocesses');
    this.active = { child, phase, timer: null };
    if (this.interruption) this.forward(this.active, this.interruption.signal);
  }

  detach(child) {
    if (this.active?.child !== child) return;
    if (this.active.timer) clearTimeout(this.active.timer);
    this.active = null;
  }

  throwIfInterrupted() {
    if (this.interruption) throw this.interruption;
  }

  get signal() {
    return this.abortController.signal;
  }
}

function runCommand(controller, file, args, options = {}) {
  controller.throwIfInterrupted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    controller.attach(child, options.phase ?? file);
    let stdout = '';
    let stderr = '';
    if (!options.interactive) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.once('error', () => {
      controller.detach(child);
      rejectPromise(
        new BootstrapError('subprocess could not start', { code: 'SUBPROCESS_START_FAILED' }),
      );
    });
    child.once('close', (code) => {
      controller.detach(child);
      if (controller.interruption) {
        rejectPromise(controller.interruption);
      } else if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const classification =
          options.failureClassifier === 'npm-view' && /\bE404\b/.test(`${stdout}\n${stderr}`)
            ? 'not-found'
            : 'ambiguous';
        rejectPromise(
          new BootstrapError('subprocess failed closed', {
            code: options.failureCode ?? 'SUBPROCESS_FAILED',
            classification,
          }),
        );
      }
    });
  });
}

const safeAmbientEnvironmentName = (name) => {
  const lower = name.toLowerCase();
  return (
    ['path', 'shell', 'term', 'colorterm', 'lang', 'tz', 'tmpdir', 'tmp', 'temp'].includes(lower) ||
    lower.startsWith('lc_') ||
    [
      'browser',
      'display',
      'wayland_display',
      'xdg_runtime_dir',
      'no_color',
      'force_color',
    ].includes(lower)
  );
};

export function buildNpmEnvironment(
  ambient,
  { userConfig, globalConfig, home, cache, temporary },
) {
  const clean = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (safeAmbientEnvironmentName(name)) clean[name] = value;
  }
  return {
    ...clean,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FETCH_RETRIES: '0',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_PROVENANCE: 'false',
    NPM_CONFIG_REGISTRY: BOOTSTRAP.registry,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_WORKSPACES: 'false',
  };
}

export function buildGitEnvironment(
  ambient,
  { home, temporary, globalConfig, systemConfig },
) {
  const clean = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (safeAmbientEnvironmentName(name)) clean[name] = value;
  }
  return {
    ...clean,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export function validatePublishConfig(manifest, label) {
  const publishConfig = manifest.publishConfig;
  if (publishConfig === undefined) return;
  if (!publishConfig || typeof publishConfig !== 'object' || Array.isArray(publishConfig)) {
    fail(`${label} has malformed publishConfig`);
  }
  const prohibited = ['registry', 'access', 'provenance'].filter((key) =>
    Object.hasOwn(publishConfig, key),
  );
  if (prohibited.length > 0) {
    fail(`${label} has prohibited publishConfig overrides: ${prohibited.join(', ')}`);
  }
}

export async function rejectProjectNpmConfigs(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.toLowerCase() === '.npmrc') {
      fail('v1.0.0 contains prohibited project npm configuration');
    }
    if (entry.isDirectory()) await rejectProjectNpmConfigs(path);
  }
}

function parsePrivateJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} is not valid JSON`, 'INVALID_PRIVATE_JSON');
  }
}

async function readJson(path, label = 'manifest') {
  return parsePrivateJson(await readFile(path, 'utf8'), label);
}

async function validateBaselineTree(source) {
  await rejectProjectNpmConfigs(source);
  const rootManifest = await readJson(join(source, 'package.json'));
  if (
    rootManifest.name !== '@fablebook/lab-01' ||
    rootManifest.version !== '1.0.0' ||
    rootManifest.private !== true
  ) {
    fail('v1.0.0 has an unexpected root manifest');
  }
  validatePublishConfig(rootManifest, 'v1.0.0 root manifest');

  for (const expected of BOOTSTRAP.packages) {
    const manifest = await readJson(join(source, expected.path, 'package.json'));
    if (manifest.name !== expected.name || manifest.version !== expected.version) {
      fail(`v1.0.0 has an unexpected manifest at ${expected.path}`);
    }
    validatePublishConfig(manifest, `${expected.name}@${expected.version}`);
  }

  const addon = await readJson(join(source, 'packages/addon/package.json'));
  if (addon.dependencies?.['@fablebook/lab-01-core'] !== '1.0.0') {
    fail('v1.0.0 add-on does not depend on the exact baseline core version');
  }
}

export function validatePackedManifest(manifest, expected) {
  if (manifest.name !== expected.name || manifest.version !== expected.version) {
    fail(`packed manifest is not ${expected.name}@${expected.version}`);
  }
  validatePublishConfig(manifest, `packed ${expected.name}@${expected.version}`);
  if (
    expected.name === '@fablebook/lab-01-addon' &&
    manifest.dependencies?.['@fablebook/lab-01-core'] !== '1.0.0'
  ) {
    fail('packed add-on does not depend on the exact baseline core version');
  }
}

export function validateArtifacts(artifacts) {
  if (artifacts.repository !== BOOTSTRAP.repository) fail('unexpected repository identity');
  if (
    artifacts.source?.tag !== BOOTSTRAP.tag ||
    artifacts.source?.commit !== BOOTSTRAP.commit ||
    artifacts.source?.tree !== BOOTSTRAP.tree
  ) {
    fail('publish inputs are not the fixed v1.0.0 commit and tree');
  }
  if (artifacts.packages.length !== BOOTSTRAP.packages.length) fail('unexpected package count');

  for (let index = 0; index < BOOTSTRAP.packages.length; index += 1) {
    const expected = BOOTSTRAP.packages[index];
    const actual = artifacts.packages[index];
    if (
      actual.name !== expected.name ||
      actual.version !== expected.version ||
      actual.path !== expected.path ||
      !hashesEqual(actual, expected)
    ) {
      fail(`unexpected package at publish position ${index + 1}`);
    }
    if (
      !actual.tarball ||
      !INTEGRITY_PATTERN.test(actual.integrity ?? '') ||
      !SHASUM_PATTERN.test(actual.shasum ?? '')
    ) {
      fail(`incomplete packed artifact for ${expected.name}@${expected.version}`);
    }
  }
}

export function classifyExisting(artifact, existing) {
  if (existing === null) return 'missing';
  if (
    !hashesEqual(artifact, existing.metadata) ||
    !hashesEqual(artifact, existing.tarball) ||
    !hashesEqual(existing.metadata, existing.tarball)
  ) {
    fail(`existing ${artifact.name}@${artifact.version} does not match the baseline artifact`);
  }
  return 'matching';
}

const npmArguments = (context, args) => [
  ...args,
  `--@fablebook:registry=${BOOTSTRAP.registry}`,
  `--globalconfig=${context.globalConfig}`,
  `--registry=${BOOTSTRAP.registry}`,
  `--userconfig=${context.userConfig}`,
  '--workspaces=false',
];

export async function prepareArtifacts(context) {
  const git = async (...args) =>
    (
      await context.run('git', ['--no-replace-objects', ...args], {
        cwd: context.root,
        env: context.gitEnvironment,
        phase: 'git-read',
      })
    ).stdout.trim();
  const root = resolve(await git('rev-parse', '--show-toplevel'));
  const remote = await git('config', '--get', 'remote.origin.url');
  if (!BOOTSTRAP.remoteUrls.includes(remote)) fail('refusing an unexpected repository remote');

  const commit = await git('rev-parse', `${BOOTSTRAP.tag}^{commit}`);
  if (commit !== BOOTSTRAP.commit) {
    fail(`${BOOTSTRAP.tag} does not identify the fixed baseline commit`);
  }
  const tree = await git('rev-parse', `${commit}^{tree}`);
  if (tree !== BOOTSTRAP.tree) fail(`${BOOTSTRAP.tag} does not identify the fixed baseline tree`);
  await context.testHooks?.afterBaselineResolved?.({ root, commit, tree });

  const archive = join(context.temporaryDirectory, 'baseline.tar');
  await context.run(
    'git',
    ['--no-replace-objects', 'archive', '--format=tar', `--output=${archive}`, commit],
    {
      cwd: root,
      env: context.gitEnvironment,
      phase: 'archive-baseline',
    },
  );
  await context.run('tar', ['-xf', archive, '-C', context.source], {
    cwd: context.commandDirectory,
    env: context.gitEnvironment,
    phase: 'extract-baseline',
  });
  await validateBaselineTree(context.source);

  const packages = [];
  for (const expected of BOOTSTRAP.packages) {
    const result = await context.run(
      'npm',
      npmArguments(context, [
        'pack',
        '--json',
        '--ignore-scripts',
        `--pack-destination=${context.packs}`,
        join(context.source, expected.path),
      ]),
      {
        cwd: context.commandDirectory,
        env: context.npmEnvironment,
        phase: `pack:${expected.name}`,
      },
    );
    const packed = parsePrivateJson(result.stdout, 'npm pack response');
    if (!Array.isArray(packed) || packed.length !== 1) fail('npm pack returned unexpected output');
    const [metadata] = packed;
    if (
      metadata.name !== expected.name ||
      metadata.version !== expected.version ||
      basename(metadata.filename ?? '') !== metadata.filename ||
      !INTEGRITY_PATTERN.test(metadata.integrity ?? '') ||
      !SHASUM_PATTERN.test(metadata.shasum ?? '')
    ) {
      fail(`npm pack produced an unexpected artifact for ${expected.name}@${expected.version}`);
    }
    const tarball = join(context.packs, metadata.filename);
    const manifestResult = await context.run('tar', ['-xOf', tarball, 'package/package.json'], {
      cwd: context.commandDirectory,
      env: context.gitEnvironment,
      phase: `inspect-pack:${expected.name}`,
    });
    validatePackedManifest(
      parsePrivateJson(manifestResult.stdout, 'packed package manifest'),
      expected,
    );
    const hashes = await hashTarball(tarball);
    if (!hashesEqual(hashes, metadata) || !hashesEqual(hashes, expected)) {
      fail(
        `packed bytes do not match the reviewed baseline for ${expected.name}@${expected.version}`,
      );
    }
    packages.push({ ...expected, tarball });
  }

  return {
    repository: BOOTSTRAP.repository,
    source: { tag: BOOTSTRAP.tag, commit, tree },
    packages,
  };
}

function validateRegistryTarballUrl(value, artifact) {
  const url = new URL(value);
  const registry = new URL(BOOTSTRAP.registry);
  if (url.origin !== registry.origin || url.protocol !== 'https:') {
    fail(`registry tarball for ${artifact.name}@${artifact.version} escaped npmjs`);
  }
  return url;
}

async function queryVersion(context, artifact) {
  try {
    const result = await context.run(
      'npm',
      npmArguments(context, ['view', `${artifact.name}@${artifact.version}`, '--json']),
      {
        cwd: context.commandDirectory,
        env: context.npmEnvironment,
        phase: `view:${artifact.name}`,
        failureCode: 'NPM_VIEW_FAILED',
        failureClassifier: 'npm-view',
      },
    );
    const manifest = parsePrivateJson(result.stdout, 'npm registry response');
    if (
      manifest.name !== artifact.name ||
      manifest.version !== artifact.version ||
      !INTEGRITY_PATTERN.test(manifest.dist?.integrity ?? '') ||
      !SHASUM_PATTERN.test(manifest.dist?.shasum ?? '') ||
      typeof manifest.dist?.tarball !== 'string'
    ) {
      fail(`registry metadata is incomplete for ${artifact.name}@${artifact.version}`);
    }
    const tarballUrl = validateRegistryTarballUrl(manifest.dist.tarball, artifact);
    const response = await fetch(tarballUrl, { signal: context.signal });
    if (!response.ok) fail(`registry tarball read failed for ${artifact.name}@${artifact.version}`);
    return {
      metadata: { integrity: manifest.dist.integrity, shasum: manifest.dist.shasum },
      tarball: hashBytes(Buffer.from(await response.arrayBuffer())),
    };
  } catch (error) {
    context.throwIfInterrupted();
    if (error instanceof BootstrapError && error.classification === 'not-found') return null;
    if (error instanceof BootstrapError && error.message.startsWith('registry ')) throw error;
    fail(`read-only registry query failed for ${artifact.name}@${artifact.version}`);
  }
}

async function login(context) {
  await context.run(
    'npm',
    npmArguments(context, ['login', '--auth-type=web', '--scope=@fablebook']),
    {
      cwd: context.commandDirectory,
      env: context.npmEnvironment,
      interactive: true,
      phase: 'npm-login',
    },
  );
  try {
    await context.run('npm', npmArguments(context, ['whoami']), {
      cwd: context.commandDirectory,
      env: context.npmEnvironment,
      phase: 'npm-whoami',
    });
  } catch (error) {
    if (error instanceof BootstrapInterrupted) throw error;
    fail('isolated npm authentication could not be verified');
  }
}

async function verifyBeforePublish(_context, artifact) {
  const hashes = await hashTarball(artifact.tarball);
  if (!hashesEqual(hashes, artifact)) {
    fail(`packed bytes changed before publishing ${artifact.name}@${artifact.version}`);
  }
  return hashes;
}

async function publish(context, artifact) {
  await context.run(
    'npm',
    npmArguments(context, [
      'publish',
      artifact.tarball,
      '--access=public',
      '--ignore-scripts',
      '--provenance=false',
    ]),
    {
      cwd: context.commandDirectory,
      env: context.npmEnvironment,
      phase: `npm-publish:${artifact.name}`,
    },
  );
}

export const bootstrapOperations = {
  prepareArtifacts,
  queryVersion,
  login,
  verifyBeforePublish,
  publish,
};

async function terminalPrompt(question, context) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question, { signal: context.signal });
  } catch {
    context.throwIfInterrupted();
    throw new BootstrapError('operator confirmation was interrupted');
  } finally {
    terminal.close();
  }
}

function packageRecords() {
  return new Map(
    BOOTSTRAP.packages.map((package_, index) => [
      package_.name,
      {
        name: package_.name,
        version: package_.version,
        order: index + 1,
        expected: null,
        observed: null,
        state: 'not-checked',
      },
    ]),
  );
}

function observe(records, artifact, existing, state) {
  const record = records.get(artifact.name);
  record.observed = existing;
  record.state = state;
}

function safeEvidence({ mode, outcome, artifacts, records, interruption, cleanupRemoved }) {
  return {
    schemaVersion: 1,
    mode,
    outcome,
    repository: BOOTSTRAP.repository,
    source: artifacts?.source ?? {
      tag: BOOTSTRAP.tag,
      commit: BOOTSTRAP.commit,
      tree: BOOTSTRAP.tree,
    },
    registry: BOOTSTRAP.registry,
    packages: [...records.values()],
    interruption: interruption
      ? {
          signal: interruption.signal,
          phase: interruption.phase,
          registryState: 'unknown-requires-integrity-readback-before-resume',
        }
      : null,
    cleanup: { temporaryStateRemoved: cleanupRemoved },
  };
}

function markInterruptedRecord(records, interruption) {
  const prefix = 'npm-publish:';
  if (interruption.phase.startsWith(prefix)) {
    const name = interruption.phase.slice(prefix.length);
    const record = records.get(name);
    if (record) record.state = 'interrupted-unknown-registry-state';
  }
}

async function assertRemoved(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
}

export async function runBootstrap({
  mode = 'preflight',
  root = process.cwd(),
  ambientEnvironment = process.env,
  operations = bootstrapOperations,
  prompt = terminalPrompt,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = (value) => console.log(JSON.stringify(value, null, 2)),
  temporaryBase = tmpdir(),
  testHooks = {},
  signalController = new SignalController(),
} = {}) {
  if (!['preflight', 'publish'].includes(mode)) fail(`unsupported mode ${mode}`);

  const records = packageRecords();
  let artifacts;
  let outcome = 'failed';
  let caught;
  let cleanupRemoved = false;
  let temporaryDirectory;
  signalController.install();

  try {
    temporaryDirectory = await mkdtemp(join(temporaryBase, 'fablebook-npm-bootstrap-'));
    signalController.throwIfInterrupted();
    await chmod(temporaryDirectory, 0o700);
    const source = join(temporaryDirectory, 'source');
    const packs = join(temporaryDirectory, 'packs');
    const home = join(temporaryDirectory, 'home');
    const cache = join(temporaryDirectory, 'cache');
    const temporary = join(temporaryDirectory, 'tmp');
    const commandDirectory = join(temporaryDirectory, 'command');
    const userConfig = join(temporaryDirectory, 'npmrc');
    const globalConfig = join(temporaryDirectory, 'global-npmrc');
    const gitGlobalConfig = join(temporaryDirectory, 'global-gitconfig');
    const gitSystemConfig = join(temporaryDirectory, 'system-gitconfig');
    await Promise.all([
      mkdir(source),
      mkdir(packs),
      mkdir(home),
      mkdir(cache),
      mkdir(temporary),
      mkdir(commandDirectory),
    ]);
    await writeFile(
      userConfig,
      [
        `registry=${BOOTSTRAP.registry}`,
        `@fablebook:registry=${BOOTSTRAP.registry}`,
        'audit=false',
        'fund=false',
        'provenance=false',
        'update-notifier=false',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await Promise.all([
      writeFile(globalConfig, '', { mode: 0o600 }),
      writeFile(gitGlobalConfig, '', { mode: 0o600 }),
      writeFile(gitSystemConfig, '', { mode: 0o600 }),
    ]);
    const npmEnvironment = buildNpmEnvironment(ambientEnvironment, {
      userConfig,
      globalConfig,
      home,
      cache,
      temporary,
    });
    const gitEnvironment = buildGitEnvironment(ambientEnvironment, {
      home,
      temporary,
      globalConfig: gitGlobalConfig,
      systemConfig: gitSystemConfig,
    });
    const context = {
      root,
      temporaryDirectory,
      source,
      packs,
      home,
      cache,
      temporary,
      commandDirectory,
      userConfig,
      globalConfig,
      npmEnvironment,
      gitEnvironment,
      signal: signalController.signal,
      throwIfInterrupted: () => signalController.throwIfInterrupted(),
      run: (file, args, options) => runCommand(signalController, file, args, options),
      testHooks,
    };

    artifacts = await operations.prepareArtifacts(context);
    signalController.throwIfInterrupted();
    validateArtifacts(artifacts);
    for (const artifact of artifacts.packages) {
      records.get(artifact.name).expected = {
        integrity: artifact.integrity,
        shasum: artifact.shasum,
      };
      const existing = await operations.queryVersion(context, artifact);
      signalController.throwIfInterrupted();
      observe(records, artifact, existing, existing === null ? 'missing' : 'observed-unverified');
      const state = classifyExisting(artifact, existing);
      observe(records, artifact, existing, state === 'matching' ? 'existing-verified' : 'missing');
    }

    if (mode === 'preflight') {
      outcome = 'preflight';
    } else {
      const missing = artifacts.packages.filter(
        (artifact) => records.get(artifact.name).state === 'missing',
      );
      if (missing.length === 0) {
        outcome = 'already-complete';
      } else {
        if (!interactive) fail('publication requires an interactive operator terminal');
        const answer = await prompt(`Type exactly \"${CONFIRMATION}\" to continue: `, context);
        signalController.throwIfInterrupted();
        if (answer !== CONFIRMATION) {
          fail('operator confirmation did not match; nothing was published');
        }

        await operations.login(context);
        signalController.throwIfInterrupted();
        for (const artifact of artifacts.packages) {
          const immediatelyExisting = await operations.queryVersion(context, artifact);
          signalController.throwIfInterrupted();
          observe(
            records,
            artifact,
            immediatelyExisting,
            immediatelyExisting === null ? 'missing' : 'observed-unverified',
          );
          if (classifyExisting(artifact, immediatelyExisting) === 'matching') {
            observe(records, artifact, immediatelyExisting, 'existing-verified');
            continue;
          }
          observe(records, artifact, null, 'ready-to-publish');

          const immediateHashes = await operations.verifyBeforePublish(context, artifact);
          signalController.throwIfInterrupted();
          if (!hashesEqual(immediateHashes, artifact)) {
            fail(`packed bytes changed before publishing ${artifact.name}@${artifact.version}`);
          }
          records.get(artifact.name).state = 'publishing-unknown-registry-state';
          try {
            await operations.publish(context, artifact);
            signalController.throwIfInterrupted();
          } catch (error) {
            if (error instanceof BootstrapInterrupted) throw error;
            records.get(artifact.name).state = 'publish-failed-unknown-registry-state';
            const raced = await operations.queryVersion(context, artifact);
            signalController.throwIfInterrupted();
            observe(
              records,
              artifact,
              raced,
              raced === null ? 'publish-failed-unknown-registry-state' : 'observed-unverified',
            );
            if (classifyExisting(artifact, raced) === 'matching') {
              observe(records, artifact, raced, 'existing-verified-after-publish-error');
              continue;
            }
            fail(
              `publication stopped at ${artifact.name}@${artifact.version}; rerun to resume safely`,
            );
          }

          const published = await operations.queryVersion(context, artifact);
          signalController.throwIfInterrupted();
          observe(
            records,
            artifact,
            published,
            published === null ? 'published-but-unverified' : 'observed-unverified',
          );
          if (classifyExisting(artifact, published) !== 'matching') {
            observe(records, artifact, published, 'published-but-unverified');
            fail(
              `published ${artifact.name}@${artifact.version} was not verified by registry read-back`,
            );
          }
          observe(records, artifact, published, 'published-and-verified');
        }
        outcome = 'published';
      }
    }
  } catch (error) {
    caught = sanitizeBoundaryError(error);
    if (caught instanceof BootstrapInterrupted) {
      outcome = 'interrupted';
      markInterruptedRecord(records, caught);
    }
  } finally {
    try {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        cleanupRemoved = await assertRemoved(temporaryDirectory);
      } else {
        cleanupRemoved = true;
      }
    } catch (error) {
      cleanupRemoved = false;
      if (!caught) caught = sanitizeBoundaryError(error);
      outcome = caught instanceof BootstrapInterrupted ? 'interrupted' : 'failed';
    }
    signalController.dispose();
  }

  if (signalController.interruption) {
    caught = sanitizeBoundaryError(signalController.interruption);
    outcome = 'interrupted';
    markInterruptedRecord(records, caught);
  }
  const evidence = safeEvidence({
    mode,
    outcome,
    artifacts,
    records,
    interruption: caught instanceof BootstrapInterrupted ? caught : null,
    cleanupRemoved,
  });
  log(evidence);
  if (caught) {
    caught.evidence = evidence;
    throw caught;
  }
  return evidence;
}

function parseMode(arguments_) {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--preflight')) {
    return 'preflight';
  }
  if (arguments_.length === 1 && arguments_[0] === '--publish') return 'publish';
  fail('usage: node scripts/bootstrap-npm-baseline.mjs [--preflight|--publish]');
}

export function exitForInterruption(error) {
  if (!(error instanceof BootstrapInterrupted)) return false;
  process.kill(process.pid, error.signal);
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runBootstrap({ mode: parseMode(process.argv.slice(2)) }).catch((error) => {
    if (exitForInterruption(error)) return;
    console.error(
      error.safeToReport ? error.message : 'bootstrap failed closed; inspect sanitized evidence',
    );
    process.exitCode = 1;
  });
}
