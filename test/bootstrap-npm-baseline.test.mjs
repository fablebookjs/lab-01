import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BOOTSTRAP,
  CONFIRMATION,
  bootstrapOperations,
  buildNpmEnvironment,
  classifyExisting,
  hashBytes,
  rejectProjectNpmConfigs,
  runBootstrap,
  validateArtifacts,
  validatePackedManifest,
  validatePublishConfig,
} from '../scripts/bootstrap-npm-baseline.mjs';

const packageHash = (index) => hashBytes(Buffer.alloc(64, index + 1));

const artifacts = () => ({
  repository: BOOTSTRAP.repository,
  source: { tag: BOOTSTRAP.tag, commit: BOOTSTRAP.commit, tree: BOOTSTRAP.tree },
  packages: BOOTSTRAP.packages.map((package_, index) => ({
    ...package_,
    tarball: `/temporary/package-${index}.tgz`,
    ...packageHash(index),
  })),
});

const matching = (artifact) => ({
  metadata: { integrity: artifact.integrity, shasum: artifact.shasum },
  tarball: { integrity: artifact.integrity, shasum: artifact.shasum },
});

const operations = (overrides = {}) => ({
  async prepareArtifacts() {
    return artifacts();
  },
  async queryVersion() {
    return null;
  },
  async login() {},
  async verifyBeforePublish(_context, artifact) {
    return { integrity: artifact.integrity, shasum: artifact.shasum };
  },
  async publish() {},
  ...overrides,
});

async function temporaryBase() {
  return mkdtemp(join(tmpdir(), 'bootstrap-test-'));
}

test('sanitizes adversarial ambient npm settings and credentials case-insensitively', () => {
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
      temporary: '/isolated/tmp',
    },
  );

  assert.deepEqual(environment, {
    PATH: '/bin',
    HOME: '/isolated/home',
    USERPROFILE: '/isolated/home',
    TMPDIR: '/isolated/tmp',
    TMP: '/isolated/tmp',
    TEMP: '/isolated/tmp',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: '/isolated/cache',
    NPM_CONFIG_FETCH_RETRIES: '0',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: '/isolated/global-npmrc',
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_PROVENANCE: 'false',
    NPM_CONFIG_REGISTRY: BOOTSTRAP.registry,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: '/isolated/npmrc',
    NPM_CONFIG_WORKSPACES: 'false',
  });
});

test('isolates user/global config and normal home, then removes all temporary state', async () => {
  const base = await temporaryBase();
  const normalHome = join(base, 'normal-home');
  const normalConfig = join(normalHome, '.npmrc');
  let temporaryDirectory;
  try {
    await mkdir(normalHome);
    await writeFile(normalConfig, 'normal-config-must-not-change\n');
    const result = await runBootstrap({
      operations: operations({
        async prepareArtifacts(context) {
          temporaryDirectory = context.temporaryDirectory;
          assert.equal(
            await readFile(context.userConfig, 'utf8'),
            [
              `registry=${BOOTSTRAP.registry}`,
              `@fablebook:registry=${BOOTSTRAP.registry}`,
              'audit=false',
              'fund=false',
              'provenance=false',
              'update-notifier=false',
              '',
            ].join('\n'),
          );
          assert.equal(await readFile(context.globalConfig, 'utf8'), '');
          assert.equal(context.npmEnvironment.HOME, context.home);
          assert.equal(context.npmEnvironment.NPM_CONFIG_USERCONFIG, context.userConfig);
          assert.equal(context.npmEnvironment.NPM_CONFIG_GLOBALCONFIG, context.globalConfig);
          assert.equal(context.npmEnvironment.npm_config_registry, undefined);
          assert.notEqual(context.commandDirectory, context.source);
          return artifacts();
        },
      }),
      ambientEnvironment: {
        PATH: '/bin',
        HOME: normalHome,
        npm_config_registry: 'https://attacker.invalid/',
      },
      temporaryBase: base,
      log() {},
    });
    assert.equal(result.outcome, 'preflight');
    assert.equal(result.cleanup.temporaryStateRemoved, true);
    assert.equal(await readFile(normalConfig, 'utf8'), 'normal-config-must-not-change\n');
    await assert.rejects(access(temporaryDirectory));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('binds the exact repository, tag, commit, tree, package versions, and order', () => {
  assert.deepEqual(
    BOOTSTRAP.packages.map(({ name, version }) => `${name}@${version}`),
    ['@fablebook/lab-01-core@1.0.0', '@fablebook/lab-01-addon@1.0.0'],
  );
  assert.doesNotThrow(() => validateArtifacts(artifacts()));

  const wrongRepository = { ...artifacts(), repository: 'storybookjs/storybook' };
  assert.throws(() => validateArtifacts(wrongRepository), /repository/);
  for (const field of ['tag', 'commit', 'tree']) {
    const changed = artifacts();
    changed.source[field] = '1111111111111111111111111111111111111111';
    assert.throws(() => validateArtifacts(changed), /fixed v1.0.0/);
  }
  const reversed = artifacts();
  reversed.packages.reverse();
  assert.throws(() => validateArtifacts(reversed), /publish position 1/);
  const wrongVersion = artifacts();
  wrongVersion.packages[0].version = '1.0.1';
  assert.throws(() => validateArtifacts(wrongVersion), /publish position 1/);
});

test('rejects project npmrc and publishConfig registry/access/provenance overrides', async () => {
  const base = await temporaryBase();
  try {
    await mkdir(join(base, 'nested'));
    await writeFile(
      join(base, 'nested', '.NPMRC'),
      '@fablebook:registry=https://attacker.invalid/\n',
    );
    await assert.rejects(rejectProjectNpmConfigs(base), /prohibited project npm configuration/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  for (const key of ['registry', 'access', 'provenance']) {
    assert.throws(
      () => validatePublishConfig({ publishConfig: { [key]: 'unsafe' } }, 'fixture'),
      new RegExp(`prohibited publishConfig overrides: ${key}`),
    );
  }
  assert.doesNotThrow(() =>
    validatePublishConfig({ publishConfig: { executable: true } }, 'fixture'),
  );

  const addon = {
    name: '@fablebook/lab-01-addon',
    version: '1.0.0',
    dependencies: { '@fablebook/lab-01-core': '1.0.0' },
  };
  assert.doesNotThrow(() => validatePackedManifest(addon, BOOTSTRAP.packages[1]));
  assert.throws(
    () => validatePackedManifest({ ...addon, version: '1.0.1' }, BOOTSTRAP.packages[1]),
    /packed manifest/,
  );
});

test('real npm command precedence defeats a project scoped-registry trap', async () => {
  const base = await temporaryBase();
  const project = join(base, 'project');
  const command = join(base, 'command');
  const userConfig = join(base, 'user.npmrc');
  const globalConfig = join(base, 'global.npmrc');
  try {
    await Promise.all([mkdir(project), mkdir(command)]);
    await writeFile(join(project, 'package.json'), '{"name":"trap","private":true}\n');
    await writeFile(join(project, '.npmrc'), '@fablebook:registry=https://project.invalid/\n');
    await writeFile(userConfig, `@fablebook:registry=${BOOTSTRAP.registry}\n`);
    await writeFile(globalConfig, '');
    const common = [
      'config',
      'get',
      '@fablebook:registry',
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
      `--registry=${BOOTSTRAP.registry}`,
      '--workspaces=false',
    ];
    const trapped = execFileSync('npm', common, { cwd: project, encoding: 'utf8' }).trim();
    assert.equal(trapped, 'https://project.invalid/');
    const pinned = execFileSync(
      'npm',
      [...common, `--@fablebook:registry=${BOOTSTRAP.registry}`],
      { cwd: command, encoding: 'utf8' },
    ).trim();
    assert.equal(pinned, BOOTSTRAP.registry);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('archives the resolved commit even if the v1.0.0 tag moves afterward', async () => {
  const base = await temporaryBase();
  const clone = join(base, 'clone');
  try {
    execFileSync('git', ['clone', '--no-hardlinks', '--quiet', process.cwd(), clone]);
    execFileSync('git', ['remote', 'set-url', 'origin', BOOTSTRAP.remoteUrls[0]], { cwd: clone });
    let moved = false;
    const result = await runBootstrap({
      root: clone,
      operations: { ...bootstrapOperations, queryVersion: async () => null },
      testHooks: {
        afterBaselineResolved({ commit, tree }) {
          assert.equal(commit, BOOTSTRAP.commit);
          assert.equal(tree, BOOTSTRAP.tree);
          execFileSync('git', ['tag', '--force', BOOTSTRAP.tag, 'HEAD'], { cwd: clone });
          moved = true;
        },
      },
      temporaryBase: base,
      log() {},
    });
    assert.equal(moved, true);
    assert.notEqual(
      execFileSync('git', ['rev-parse', `${BOOTSTRAP.tag}^{commit}`], {
        cwd: clone,
        encoding: 'utf8',
      }).trim(),
      BOOTSTRAP.commit,
    );
    assert.deepEqual(result.source, {
      tag: BOOTSTRAP.tag,
      commit: BOOTSTRAP.commit,
      tree: BOOTSTRAP.tree,
    });
    assert.deepEqual(
      result.packages.map(({ expected }) => expected),
      [
        {
          integrity:
            'sha512-D2/F0PkQoENQagqntg1tUB0zn8lOen0jnqvyw0sbRLN3fkMJ4OR60geERuANxq0Ihx0RlCoYoP1lQhzb2KQZ+g==',
          shasum: '8ff5241867ebd1c2747c23ea016342c7cd101f6d',
        },
        {
          integrity:
            'sha512-DssrVgnRMbPG5qVqt0yr43ImplnR2YJZyCZkr0Yvp5h+wJHo5x9qL2Svpo3GyruuMZm1zdIhKJPAYYmZe7m78g==',
          shasum: '5ccab401d844a0254bd1914b5b96d798462a5017',
        },
      ],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('accepts an existing version only when metadata and downloaded bytes match', () => {
  const [artifact] = artifacts().packages;
  assert.equal(classifyExisting(artifact, null), 'missing');
  assert.equal(classifyExisting(artifact, matching(artifact)), 'matching');
  for (const location of ['metadata', 'tarball']) {
    const mismatch = matching(artifact);
    mismatch[location].integrity = packageHash(9).integrity;
    assert.throws(() => classifyExisting(artifact, mismatch), /does not match/);
  }
});

test('requires exact TTY confirmation before isolated web login or publication', async () => {
  const base = await temporaryBase();
  const events = [];
  try {
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations({
          async login() {
            events.push('login');
          },
          async publish(_context, artifact) {
            events.push(`publish:${artifact.name}`);
          },
        }),
        interactive: true,
        prompt: async () => 'yes',
        temporaryBase: base,
        log() {},
      }),
      /confirmation did not match/,
    );
    assert.deepEqual(events, []);
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations(),
        interactive: false,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log() {},
      }),
      /interactive operator terminal/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('publishes missing packages core then add-on and retains complete hash evidence', async () => {
  const base = await temporaryBase();
  const published = new Set();
  const events = [];
  try {
    const result = await runBootstrap({
      mode: 'publish',
      operations: operations({
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
      }),
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
    for (const package_ of result.packages) {
      assert.deepEqual(package_.expected, package_.observed.metadata);
      assert.deepEqual(package_.expected, package_.observed.tarball);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resumes after a verified core by publishing only the missing add-on', async () => {
  const base = await temporaryBase();
  const [core, addon] = artifacts().packages;
  let addonPublished = false;
  const events = [];
  try {
    const result = await runBootstrap({
      mode: 'publish',
      operations: operations({
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
      }),
      interactive: true,
      prompt: async () => CONFIRMATION,
      temporaryBase: base,
      log() {},
    });
    assert.deepEqual(events, ['login', 'publish:@fablebook/lab-01-addon']);
    assert.deepEqual(
      result.packages.map(({ state }) => state),
      ['existing-verified', 'published-and-verified'],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('fails before publish if packed bytes changed after preparation', async () => {
  const base = await temporaryBase();
  let publishCalled = false;
  try {
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations({
          async verifyBeforePublish() {
            return packageHash(9);
          },
          async publish() {
            publishCalled = true;
          },
        }),
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log() {},
      }),
      /packed bytes changed before publishing/,
    );
    assert.equal(publishCalled, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('default irreversible-boundary check rehashes the current tarball bytes', async () => {
  const base = await temporaryBase();
  const tarball = join(base, 'candidate.tgz');
  try {
    await writeFile(tarball, 'packed-before-review');
    const expected = hashBytes(Buffer.from('packed-before-review'));
    const artifact = { ...BOOTSTRAP.packages[0], tarball, ...expected };
    assert.deepEqual(await bootstrapOperations.verifyBeforePublish({}, artifact), expected);
    await writeFile(tarball, 'changed-after-pack');
    await assert.rejects(
      bootstrapOperations.verifyBeforePublish({}, artifact),
      /packed bytes changed before publishing/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('mismatch and registry uncertainty fail closed with sanitized evidence', async () => {
  const base = await temporaryBase();
  try {
    let loginCalled = false;
    const mismatchEvidence = [];
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations({
          async queryVersion(_context, artifact) {
            if (artifact.name !== BOOTSTRAP.packages[0].name) return null;
            const value = matching(artifact);
            value.metadata.integrity = packageHash(9).integrity;
            return value;
          },
          async login() {
            loginCalled = true;
          },
        }),
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log(value) {
          mismatchEvidence.push(value);
        },
      }),
      /does not match/,
    );
    assert.equal(loginCalled, false);
    assert.equal(mismatchEvidence[0].outcome, 'failed');
    assert.deepEqual(mismatchEvidence[0].packages[0].observed.metadata, {
      integrity: packageHash(9).integrity,
      shasum: artifacts().packages[0].shasum,
    });

    let temporaryDirectory;
    const failureEvidence = [];
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations({
          async prepareArtifacts(context) {
            temporaryDirectory = context.temporaryDirectory;
            return artifacts();
          },
          async publish(context) {
            throw new Error(`raw-token-must-not-escape ${context.userConfig}`);
          },
        }),
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log(value) {
          failureEvidence.push(value);
        },
      }),
      /publication stopped at @fablebook\/lab-01-core@1.0.0/,
    );
    assert.equal(failureEvidence[0].packages[0].state, 'publish-failed-unknown-registry-state');
    assert.equal(failureEvidence[0].cleanup.temporaryStateRemoved, true);
    const retained = JSON.stringify(failureEvidence[0]);
    assert.equal(retained.includes('raw-token-must-not-escape'), false);
    assert.equal(retained.includes(temporaryDirectory), false);
    assert.equal(retained.includes('npmrc'), false);
    await assert.rejects(access(temporaryDirectory));

    const readbackEvidence = [];
    await assert.rejects(
      runBootstrap({
        mode: 'publish',
        operations: operations(),
        interactive: true,
        prompt: async () => CONFIRMATION,
        temporaryBase: base,
        log(value) {
          readbackEvidence.push(value);
        },
      }),
      /was not verified by registry read-back/,
    );
    assert.equal(readbackEvidence[0].packages[0].state, 'published-but-unverified');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
