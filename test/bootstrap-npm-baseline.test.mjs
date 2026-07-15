import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BOOTSTRAP,
  CONFIRMATION,
  buildNpmEnvironment,
  classifyExisting,
  runBootstrap,
  validateArtifacts,
} from '../scripts/bootstrap-npm-baseline.mjs';

const artifacts = () => ({
  repository: BOOTSTRAP.repository,
  tag: BOOTSTRAP.tag,
  commit: BOOTSTRAP.commit,
  packages: BOOTSTRAP.packages.map((package_, index) => ({
    ...package_,
    tarball: `/temporary/package-${index}.tgz`,
    integrity: `sha512-integrity-${index}`,
    shasum: `shasum-${index}`,
  })),
});

const matching = (artifact) => ({ integrity: artifact.integrity, shasum: artifact.shasum });

async function temporaryBase() {
  return mkdtemp(join(tmpdir(), 'bootstrap-test-'));
}

test('sanitizes adversarial ambient npm settings and credentials case-insensitively', async () => {
  const environment = buildNpmEnvironment(
    {
      PATH: '/bin',
      SAFE_VALUE: 'not-forwarded',
      npm_config_registry: 'https://attacker.invalid/',
      NpM_CoNfIg_UsErCoNfIg: '/normal/npmrc',
      NODE_AUTH_TOKEN: 'not-forwarded',
      npm_ToKeN: 'not-forwarded',
      SOME_PASSWORD: 'not-forwarded',
      credential_helper: 'not-forwarded',
      GITHUB_PAT: 'not-forwarded',
      AWS_ACCESS_KEY_ID: 'not-forwarded',
    },
    {
      userConfig: '/isolated/npmrc',
      globalConfig: '/isolated/global-npmrc',
      home: '/isolated/home',
      cache: '/isolated/cache',
    },
  );

  assert.deepEqual(environment, {
    PATH: '/bin',
    HOME: '/isolated/home',
    NPM_CONFIG_CACHE: '/isolated/cache',
    NPM_CONFIG_GLOBALCONFIG: '/isolated/global-npmrc',
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_REGISTRY: BOOTSTRAP.registry,
    NPM_CONFIG_USERCONFIG: '/isolated/npmrc',
  });
});

test('creates only an isolated config with both registry bindings and removes it after preflight', async () => {
  const base = await temporaryBase();
  const normalHome = join(base, 'normal-home');
  const normalConfig = join(normalHome, '.npmrc');
  let temporaryDirectory;
  try {
    await mkdir(normalHome);
    await writeFile(normalConfig, 'normal-config-must-not-change\n');
    const operations = {
      async prepareArtifacts(context) {
        temporaryDirectory = context.temporaryDirectory;
        assert.equal(
          await readFile(context.userConfig, 'utf8'),
          `registry=${BOOTSTRAP.registry}\n@fablebook:registry=${BOOTSTRAP.registry}\n`,
        );
        assert.equal(context.npmEnvironment.NPM_CONFIG_REGISTRY, BOOTSTRAP.registry);
        assert.equal(context.npmEnvironment.NPM_CONFIG_USERCONFIG, context.userConfig);
        assert.equal(context.npmEnvironment.NPM_CONFIG_GLOBALCONFIG, context.globalConfig);
        assert.equal(await readFile(context.globalConfig, 'utf8'), '');
        assert.equal(context.npmEnvironment.npm_config_registry, undefined);
        return artifacts();
      },
      async queryVersion() {
        return null;
      },
    };

    const result = await runBootstrap({
      operations,
      ambientEnvironment: {
        PATH: '/bin',
        HOME: normalHome,
        npm_config_registry: 'https://attacker.invalid/',
      },
      temporaryBase: base,
      log() {},
    });
    assert.equal(result.mode, 'preflight');
    assert.equal(await readFile(normalConfig, 'utf8'), 'normal-config-must-not-change\n');
    await assert.rejects(access(temporaryDirectory));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('binds the exact repository, tag, commit, package versions, and core-first order', () => {
  assert.deepEqual(
    BOOTSTRAP.packages.map(({ name, version }) => `${name}@${version}`),
    ['@fablebook/lab-01-core@1.0.0', '@fablebook/lab-01-addon@1.0.0'],
  );
  assert.doesNotThrow(() => validateArtifacts(artifacts()));

  for (const changed of [
    { repository: 'storybookjs/storybook' },
    { tag: 'releases/v1.0' },
    { commit: '1111111111111111111111111111111111111111' },
  ]) {
    assert.throws(() => validateArtifacts({ ...artifacts(), ...changed }), /unexpected|fixed/);
  }

  const reversed = artifacts();
  reversed.packages.reverse();
  assert.throws(() => validateArtifacts(reversed), /publish position 1/);

  const wrongVersion = artifacts();
  wrongVersion.packages[0].version = '1.0.1';
  assert.throws(() => validateArtifacts(wrongVersion), /publish position 1/);
});

test('accepts an existing version only when both packed hashes match', () => {
  const [artifact] = artifacts().packages;
  assert.equal(classifyExisting(artifact, null), 'missing');
  assert.equal(classifyExisting(artifact, matching(artifact)), 'matching');
  assert.throws(
    () => classifyExisting(artifact, { ...matching(artifact), integrity: 'sha512-other' }),
    /does not match/,
  );
  assert.throws(
    () => classifyExisting(artifact, { ...matching(artifact), shasum: 'other' }),
    /does not match/,
  );
});

test('requires an exact interactive confirmation before login or publication', async () => {
  const base = await temporaryBase();
  const events = [];
  try {
    const operations = {
      async prepareArtifacts() {
        return artifacts();
      },
      async queryVersion() {
        return null;
      },
      async login() {
        events.push('login');
      },
      async publish(_context, artifact) {
        events.push(`publish:${artifact.name}`);
      },
    };
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations,
        interactive: true,
        prompt: async () => 'yes',
        temporaryBase: base,
        log() {},
      }),
      /confirmation did not match/,
    );
    assert.deepEqual(events, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('refuses publish mode without an interactive operator terminal', async () => {
  const base = await temporaryBase();
  let promptCalled = false;
  try {
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: {
          async prepareArtifacts() {
            return artifacts();
          },
          async queryVersion() {
            return null;
          },
        },
        interactive: false,
        prompt: async () => {
          promptCalled = true;
          return CONFIRMATION;
        },
        temporaryBase: base,
        log() {},
      }),
      /interactive operator terminal/,
    );
    assert.equal(promptCalled, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('publishes missing packages core then add-on and verifies each result', async () => {
  const base = await temporaryBase();
  const published = new Set();
  const events = [];
  try {
    const operations = {
      async prepareArtifacts() {
        return artifacts();
      },
      async queryVersion(_context, artifact) {
        return published.has(artifact.name) ? matching(artifact) : null;
      },
      async login() {
        events.push('login');
      },
      async publish(_context, artifact) {
        events.push(`publish:${artifact.name}`);
        published.add(artifact.name);
      },
    };
    const result = await runBootstrap({
      mode: 'publish',
      operations,
      interactive: true,
      prompt: async () => CONFIRMATION,
      temporaryBase: base,
      log() {},
    });
    assert.deepEqual(events, [
      'login',
      'publish:@fablebook/lab-01-core',
      'publish:@fablebook/lab-01-addon',
    ]);
    assert.deepEqual(
      result.packages.map(({ state }) => state),
      ['published-and-verified', 'published-and-verified'],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resumes after a matching core by publishing only the missing add-on', async () => {
  const base = await temporaryBase();
  const [core, addon] = artifacts().packages;
  let addonPublished = false;
  const events = [];
  try {
    const operations = {
      async prepareArtifacts() {
        return artifacts();
      },
      async queryVersion(_context, artifact) {
        if (artifact.name === core.name) return matching(artifact);
        return addonPublished ? matching(artifact) : null;
      },
      async login() {
        events.push('login');
      },
      async publish(_context, artifact) {
        assert.equal(artifact.name, addon.name);
        events.push(`publish:${artifact.name}`);
        addonPublished = true;
      },
    };
    await runBootstrap({
      mode: 'publish',
      operations,
      interactive: true,
      prompt: async () => CONFIRMATION,
      temporaryBase: base,
      log() {},
    });
    assert.deepEqual(events, ['login', 'publish:@fablebook/lab-01-addon']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('stops on a mismatch before login and cleans up after publish failure', async () => {
  const mismatchBase = await temporaryBase();
  let loginCalled = false;
  try {
    const operations = {
      async prepareArtifacts() {
        return artifacts();
      },
      async queryVersion(_context, artifact) {
        if (artifact.name === BOOTSTRAP.packages[0].name) {
          return { ...matching(artifact), integrity: 'sha512-conflict' };
        }
        return null;
      },
      async login() {
        loginCalled = true;
      },
    };
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations,
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: mismatchBase,
        log() {},
      }),
      /does not match/,
    );
    assert.equal(loginCalled, false);
  } finally {
    await rm(mismatchBase, { recursive: true, force: true });
  }

  const failureBase = await temporaryBase();
  let temporaryDirectory;
  const published = [];
  try {
    const operations = {
      async prepareArtifacts(context) {
        temporaryDirectory = context.temporaryDirectory;
        return artifacts();
      },
      async queryVersion() {
        return null;
      },
      async login() {},
      async publish(_context, artifact) {
        published.push(artifact.name);
        throw new Error('simulated failure');
      },
    };
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations,
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: failureBase,
        log() {},
      }),
      /stopped at @fablebook\/lab-01-core@1.0.0; rerun to resume safely/,
    );
    assert.deepEqual(published, ['@fablebook/lab-01-core']);
    await assert.rejects(access(temporaryDirectory));
  } finally {
    await rm(failureBase, { recursive: true, force: true });
  }
});

test('fails closed when a successful publish is absent from registry read-back', async () => {
  const base = await temporaryBase();
  let temporaryDirectory;
  const published = [];
  try {
    const operations = {
      async prepareArtifacts(context) {
        temporaryDirectory = context.temporaryDirectory;
        return artifacts();
      },
      async queryVersion() {
        return null;
      },
      async login() {},
      async publish(_context, artifact) {
        published.push(artifact.name);
      },
    };
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations,
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log() {},
      }),
      /was not verified by registry read-back/,
    );
    assert.deepEqual(published, ['@fablebook/lab-01-core']);
    await assert.rejects(access(temporaryDirectory));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
