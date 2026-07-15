import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  registry: 'https://registry.npmjs.org/',
  packages: Object.freeze([
    Object.freeze({ name: '@fablebook/lab-01-core', version: '1.0.0', path: 'packages/core' }),
    Object.freeze({ name: '@fablebook/lab-01-addon', version: '1.0.0', path: 'packages/addon' }),
  ]),
});

export const CONFIRMATION =
  'publish @fablebook/lab-01-core@1.0.0 then @fablebook/lab-01-addon@1.0.0';

const fail = (message) => {
  throw new Error(message);
};

const safeAmbientEnvironmentName = (name) => {
  const lower = name.toLowerCase();
  return (
    ['path', 'shell', 'term', 'colorterm', 'lang', 'tz', 'tmpdir', 'tmp', 'temp'].includes(lower) ||
    lower.startsWith('lc_') ||
    ['browser', 'display', 'wayland_display', 'xdg_runtime_dir', 'no_color', 'force_color'].includes(
      lower,
    )
  );
};

export function buildNpmEnvironment(ambient, { userConfig, globalConfig, home, cache }) {
  const clean = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (safeAmbientEnvironmentName(name)) clean[name] = value;
  }
  return {
    ...clean,
    HOME: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_REGISTRY: BOOTSTRAP.registry,
    NPM_CONFIG_USERCONFIG: userConfig,
  };
}

export function validateArtifacts(artifacts) {
  if (artifacts.repository !== BOOTSTRAP.repository) fail('unexpected repository identity');
  if (artifacts.tag !== BOOTSTRAP.tag || artifacts.commit !== BOOTSTRAP.commit) {
    fail('publish inputs are not the fixed v1.0.0 baseline');
  }
  if (artifacts.packages.length !== BOOTSTRAP.packages.length) {
    fail('unexpected package count');
  }

  for (let index = 0; index < BOOTSTRAP.packages.length; index += 1) {
    const expected = BOOTSTRAP.packages[index];
    const actual = artifacts.packages[index];
    if (
      actual.name !== expected.name ||
      actual.version !== expected.version ||
      actual.path !== expected.path
    ) {
      fail(`unexpected package at publish position ${index + 1}`);
    }
    if (!actual.tarball || !actual.integrity || !actual.shasum) {
      fail(`incomplete packed artifact for ${expected.name}@${expected.version}`);
    }
  }
}

export function classifyExisting(artifact, existing) {
  if (existing === null) return 'missing';
  if (existing.integrity !== artifact.integrity || existing.shasum !== artifact.shasum) {
    fail(`existing ${artifact.name}@${artifact.version} does not match the baseline artifact`);
  }
  return 'matching';
}

function run(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
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
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const error = new Error(`${file} exited with status ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      }
    });
  });
}

const git = async (root, ...args) =>
  (await run('git', args, { cwd: root, env: process.env })).stdout.trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function validateBaselineTree(source) {
  const rootManifest = await readJson(join(source, 'package.json'));
  if (
    rootManifest.name !== '@fablebook/lab-01' ||
    rootManifest.version !== '1.0.0' ||
    rootManifest.private !== true
  ) {
    fail('v1.0.0 has an unexpected root manifest');
  }

  for (const expected of BOOTSTRAP.packages) {
    const manifest = await readJson(join(source, expected.path, 'package.json'));
    if (manifest.name !== expected.name || manifest.version !== expected.version) {
      fail(`v1.0.0 has an unexpected manifest at ${expected.path}`);
    }
  }

  const addon = await readJson(join(source, 'packages/addon/package.json'));
  if (addon.dependencies?.['@fablebook/lab-01-core'] !== '1.0.0') {
    fail('v1.0.0 add-on does not depend on the exact baseline core version');
  }
}

async function prepareArtifacts(context) {
  const root = resolve(await git(context.root, 'rev-parse', '--show-toplevel'));
  const remote = await git(root, 'config', '--get', 'remote.origin.url');
  if (!BOOTSTRAP.remoteUrls.includes(remote)) fail('refusing an unexpected repository remote');

  const commit = await git(root, 'rev-parse', `${BOOTSTRAP.tag}^{commit}`);
  if (commit !== BOOTSTRAP.commit) fail(`${BOOTSTRAP.tag} does not identify the fixed baseline commit`);

  const archive = join(context.temporaryDirectory, 'baseline.tar');
  await run('git', ['archive', '--format=tar', `--output=${archive}`, BOOTSTRAP.tag], {
    cwd: root,
    env: process.env,
  });
  await run('tar', ['-xf', archive, '-C', context.source], { env: process.env });
  await validateBaselineTree(context.source);

  const packages = [];
  for (const expected of BOOTSTRAP.packages) {
    const result = await run(
      'npm',
      [
        'pack',
        '--json',
        '--ignore-scripts',
        `--pack-destination=${context.packs}`,
        join(context.source, expected.path),
      ],
      { cwd: context.source, env: context.npmEnvironment },
    );
    const packed = JSON.parse(result.stdout);
    if (!Array.isArray(packed) || packed.length !== 1) fail(`npm pack returned unexpected output`);
    const [artifact] = packed;
    packages.push({
      ...expected,
      tarball: join(context.packs, basename(artifact.filename)),
      integrity: artifact.integrity,
      shasum: artifact.shasum,
    });
  }

  return { repository: BOOTSTRAP.repository, tag: BOOTSTRAP.tag, commit, packages };
}

const npmArguments = (context, args) => [
  ...args,
  `--globalconfig=${context.globalConfig}`,
  `--registry=${BOOTSTRAP.registry}`,
  `--userconfig=${context.userConfig}`,
];

async function queryVersion(context, artifact) {
  try {
    const result = await run(
      'npm',
      npmArguments(context, ['view', `${artifact.name}@${artifact.version}`, '--json']),
      { cwd: context.source, env: context.npmEnvironment },
    );
    const manifest = JSON.parse(result.stdout);
    if (!manifest.dist?.integrity || !manifest.dist?.shasum) {
      fail(`registry metadata is incomplete for ${artifact.name}@${artifact.version}`);
    }
    return { integrity: manifest.dist.integrity, shasum: manifest.dist.shasum };
  } catch (error) {
    const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    if (/\bE404\b/.test(diagnostic)) return null;
    if (error.message.startsWith('registry metadata is incomplete')) throw error;
    fail(`read-only registry query failed for ${artifact.name}@${artifact.version}`);
  }
}

async function login(context) {
  await run(
    'npm',
    npmArguments(context, ['login', '--auth-type=web', '--scope=@fablebook']),
    { cwd: context.source, env: context.npmEnvironment, interactive: true },
  );
  try {
    await run('npm', npmArguments(context, ['whoami']), {
      cwd: context.source,
      env: context.npmEnvironment,
    });
  } catch {
    fail('isolated npm authentication could not be verified');
  }
}

async function publish(context, artifact) {
  await run(
    'npm',
    npmArguments(context, ['publish', artifact.tarball, '--access=public', '--ignore-scripts']),
    { cwd: context.source, env: context.npmEnvironment },
  );
}

const defaultOperations = { prepareArtifacts, queryVersion, login, publish };

async function terminalPrompt(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

function safeSummary(mode, artifacts, states) {
  return {
    mode,
    repository: artifacts.repository,
    source: { tag: artifacts.tag, commit: artifacts.commit },
    registry: BOOTSTRAP.registry,
    packages: artifacts.packages.map((artifact, index) => ({
      name: artifact.name,
      version: artifact.version,
      order: index + 1,
      integrity: artifact.integrity,
      state: states.get(artifact.name),
    })),
  };
}

export async function runBootstrap({
  mode = 'preflight',
  root = process.cwd(),
  ambientEnvironment = process.env,
  operations = defaultOperations,
  prompt = terminalPrompt,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = (value) => console.log(JSON.stringify(value, null, 2)),
  temporaryBase = tmpdir(),
} = {}) {
  if (!['preflight', 'publish'].includes(mode)) fail(`unsupported mode ${mode}`);

  const temporaryDirectory = await mkdtemp(join(temporaryBase, 'fablebook-npm-bootstrap-'));
  await chmod(temporaryDirectory, 0o700);
  const source = join(temporaryDirectory, 'source');
  const packs = join(temporaryDirectory, 'packs');
  const home = join(temporaryDirectory, 'home');
  const cache = join(temporaryDirectory, 'cache');
  const userConfig = join(temporaryDirectory, 'npmrc');
  const globalConfig = join(temporaryDirectory, 'global-npmrc');

  try {
    await Promise.all([mkdir(source), mkdir(packs), mkdir(home), mkdir(cache)]);
    await writeFile(
      userConfig,
      `registry=${BOOTSTRAP.registry}\n@fablebook:registry=${BOOTSTRAP.registry}\n`,
      { mode: 0o600 },
    );
    await writeFile(globalConfig, '', { mode: 0o600 });
    const npmEnvironment = buildNpmEnvironment(ambientEnvironment, {
      userConfig,
      globalConfig,
      home,
      cache,
    });
    const context = {
      root,
      temporaryDirectory,
      source,
      packs,
      home,
      cache,
      userConfig,
      globalConfig,
      npmEnvironment,
    };

    const artifacts = await operations.prepareArtifacts(context);
    validateArtifacts(artifacts);
    const states = new Map();
    for (const artifact of artifacts.packages) {
      states.set(artifact.name, classifyExisting(artifact, await operations.queryVersion(context, artifact)));
    }

    if (mode === 'preflight') {
      log(safeSummary('preflight', artifacts, states));
      return safeSummary('preflight', artifacts, states);
    }

    const missing = artifacts.packages.filter((artifact) => states.get(artifact.name) === 'missing');
    if (missing.length === 0) {
      log(safeSummary('already-complete', artifacts, states));
      return safeSummary('already-complete', artifacts, states);
    }
    if (!interactive) fail('publication requires an interactive operator terminal');
    const answer = await prompt(`Type exactly \"${CONFIRMATION}\" to continue: `);
    if (answer !== CONFIRMATION) fail('operator confirmation did not match; nothing was published');

    await operations.login(context);
    for (const artifact of artifacts.packages) {
      const immediatelyExisting = await operations.queryVersion(context, artifact);
      if (classifyExisting(artifact, immediatelyExisting) === 'matching') {
        states.set(artifact.name, 'matching');
        continue;
      }

      try {
        await operations.publish(context, artifact);
      } catch {
        const raced = await operations.queryVersion(context, artifact);
        if (classifyExisting(artifact, raced) === 'matching') {
          states.set(artifact.name, 'matching');
          continue;
        }
        fail(`publication stopped at ${artifact.name}@${artifact.version}; rerun to resume safely`);
      }

      if (
        classifyExisting(artifact, await operations.queryVersion(context, artifact)) !== 'matching'
      ) {
        fail(`published ${artifact.name}@${artifact.version} was not verified by registry read-back`);
      }
      states.set(artifact.name, 'published-and-verified');
    }

    log(safeSummary('published', artifacts, states));
    return safeSummary('published', artifacts, states);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseMode(arguments_) {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--preflight')) {
    return 'preflight';
  }
  if (arguments_.length === 1 && arguments_[0] === '--publish') return 'publish';
  fail('usage: node scripts/bootstrap-npm-baseline.mjs [--preflight|--publish]');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runBootstrap({ mode: parseMode(process.argv.slice(2)) }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
