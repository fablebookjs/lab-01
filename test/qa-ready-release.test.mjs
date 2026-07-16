import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  PACKAGE_SPECS,
  RELEASE_VERSION,
  REPOSITORY,
  RELEASE_LINE,
  STAGED_LINE,
  TRANSFORMED_FILES,
  assertRegistryOnlyConsumerLock,
  buildExpectedEvidenceContract,
  createIsolatedNpmEnvironment,
  localAuthority,
  main as qaMain,
  transformCandidate,
  validateEvidenceBinding,
  validateGitHubAuthoritySnapshot,
  validateReadyQaWakeup,
  withTemporaryDirectory,
} from '../scripts/qa-ready-release.mjs';

const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function candidateFixture(directory) {
  await mkdir(join(directory, 'packages/core'), { recursive: true });
  await mkdir(join(directory, 'packages/addon'), { recursive: true });
  await writeJson(join(directory, 'package.json'), {
    name: '@fablebook/lab-01',
    version: '1.0.0',
    private: true,
    workspaces: ['packages/*'],
  });
  await writeJson(join(directory, 'packages/core/package.json'), {
    name: PACKAGE_SPECS[0].name,
    version: '1.0.0',
  });
  await writeJson(join(directory, 'packages/addon/package.json'), {
    name: PACKAGE_SPECS[1].name,
    version: '1.0.0',
    dependencies: { [PACKAGE_SPECS[0].name]: '1.0.0' },
  });
  await writeJson(join(directory, 'package-lock.json'), {
    name: '@fablebook/lab-01',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: '@fablebook/lab-01',
        version: '1.0.0',
        workspaces: ['packages/*'],
      },
      'node_modules/@fablebook/lab-01-addon': { resolved: 'packages/addon', link: true },
      'node_modules/@fablebook/lab-01-core': { resolved: 'packages/core', link: true },
      'packages/addon': {
        name: PACKAGE_SPECS[1].name,
        version: '1.0.0',
        dependencies: { [PACKAGE_SPECS[0].name]: '1.0.0' },
      },
      'packages/core': { name: PACKAGE_SPECS[0].name, version: '1.0.0' },
    },
  });
}

test('the version materialization changes only allowlisted fields and keeps the exact core edge', async () => {
  await withTemporaryDirectory('lab-01-transform-test-', async (directory) => {
    await candidateFixture(directory);
    const before = new Map(
      await Promise.all(
        TRANSFORMED_FILES.map(async (path) => [path, await readFile(join(directory, path), 'utf8')]),
      ),
    );
    await transformCandidate(directory);
    for (const path of TRANSFORMED_FILES) {
      assert.notEqual(await readFile(join(directory, path), 'utf8'), before.get(path));
    }
    const root = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const core = JSON.parse(await readFile(join(directory, 'packages/core/package.json'), 'utf8'));
    const addon = JSON.parse(await readFile(join(directory, 'packages/addon/package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(root.version, RELEASE_VERSION);
    assert.equal(core.version, RELEASE_VERSION);
    assert.equal(addon.version, RELEASE_VERSION);
    assert.equal(addon.dependencies[PACKAGE_SPECS[0].name], RELEASE_VERSION);
    assert.equal(
      lock.packages['packages/addon'].dependencies[PACKAGE_SPECS[0].name],
      RELEASE_VERSION,
    );
  });
});

test('consumer proof accepts only exact loopback registry tarballs and rejects workspace resolution', () => {
  const origin = 'http://127.0.0.1:4873/';
  const packages = PACKAGE_SPECS.map(({ name }) => ({ name, integrity }));
  const lock = {
    packages: {
      '': {
        dependencies: Object.fromEntries(PACKAGE_SPECS.map(({ name }) => [name, RELEASE_VERSION])),
      },
      [`node_modules/${PACKAGE_SPECS[0].name}`]: {
        version: RELEASE_VERSION,
        resolved: `${origin}@fablebook/lab-01-core/-/lab-01-core-1.0.1.tgz`,
        integrity,
      },
      [`node_modules/${PACKAGE_SPECS[1].name}`]: {
        version: RELEASE_VERSION,
        resolved: `${origin}@fablebook/lab-01-addon/-/lab-01-addon-1.0.1.tgz`,
        integrity,
        dependencies: { [PACKAGE_SPECS[0].name]: RELEASE_VERSION },
      },
    },
  };
  assert.doesNotThrow(() => assertRegistryOnlyConsumerLock(lock, origin, packages));
  lock.packages[`node_modules/${PACKAGE_SPECS[0].name}`].resolved = 'file:../../packages/core';
  assert.throws(() => assertRegistryOnlyConsumerLock(lock, origin, packages), /outside the registry/);
});

function evidenceFixture() {
  const origin = 'http://127.0.0.1:4873/';
  const packages = PACKAGE_SPECS.map(({ name }, index) => ({
    name,
    version: RELEASE_VERSION,
    integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}`,
    shasum: String(index + 1).repeat(40),
    metadataUrl: new URL(`/${encodeURIComponent(name)}/${RELEASE_VERSION}`, origin).href,
    tarballUrl: new URL(
      `/${name}/-/${name.slice(name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`,
      origin,
    ).href,
  }));
  const steps = [
    ['candidate:install', 'npm ci --omit=dev --offline (loopback registry)'],
    [`pack:${PACKAGE_SPECS[0].name}`, 'npm pack ./packages/core'],
    [`pack:${PACKAGE_SPECS[1].name}`, 'npm pack ./packages/addon'],
    [`publish:${PACKAGE_SPECS[0].name}`, 'npm publish (loopback registry)'],
    [`publish:${PACKAGE_SPECS[1].name}`, 'npm publish (loopback registry)'],
    ['consumer:install', 'npm install (loopback registry)'],
    ['consumer:test', 'npm test'],
  ].map(([name, command]) => ({ name, command, durationMs: 1 }));
  return buildExpectedEvidenceContract({
    authority: localAuthority(),
    stagedSha: '1'.repeat(40),
    sourceSha: '2'.repeat(40),
    sourceTree: '3'.repeat(40),
    transformedTree: '4'.repeat(40),
    transformedContentSha256: '5'.repeat(64),
    registryOrigin: origin,
    packages,
    steps,
  });
}

test('one-field-at-a-time evidence forgeries fail across every authoritative section', () => {
  const expected = evidenceFixture();
  assert.doesNotThrow(() => validateEvidenceBinding(structuredClone(expected), expected));
  const forgeries = [
    ['schema', (value) => (value.schemaVersion = 1)],
    ['repository', (value) => (value.repository = 'storybookjs/storybook')],
    ['authority mode', (value) => (value.authority.mode = 'github-current')],
    ['authority current flag', (value) => (value.authority.githubCurrent = true)],
    ['release version', (value) => (value.release.version = '1.0.2')],
    ['staged SHA', (value) => (value.release.stagedSha = '6'.repeat(40))],
    ['source SHA', (value) => (value.release.sourceSha = '6'.repeat(40))],
    ['source tree', (value) => (value.release.sourceTree = '6'.repeat(40))],
    ['transformed tree', (value) => (value.release.transformedTree = '6'.repeat(40))],
    ['content identity', (value) => (value.release.transformedContentSha256 = '6'.repeat(64))],
    ['transform files', (value) => value.transformation.files.pop()],
    ['transform packages', (value) => value.transformation.packageNames.reverse()],
    ['internal dependency', (value) => (value.transformation.addonCoreDependency = '1.0.0')],
    ['registry implementation', (value) => (value.registry.implementation.name = 'other')],
    ['registry version', (value) => (value.registry.implementation.version = 'latest')],
    ['registry origin', (value) => (value.registry.origin = 'https://registry.npmjs.org/')],
    ['registry loopback flag', (value) => (value.registry.loopbackOnly = false)],
    ['registry uplink flag', (value) => (value.registry.noUplinks = false)],
    ['registry auth flag', (value) => (value.registry.authenticatedPublish = false)],
    ['registry allowlist', (value) => value.registry.allowedPackages.push('@fablebook/other')],
    ['core name', (value) => (value.registry.packages[0].name = '@fablebook/other')],
    ['core version', (value) => (value.registry.packages[0].version = '1.0.0')],
    ['core integrity', (value) => (value.registry.packages[0].integrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`)],
    ['core shasum', (value) => (value.registry.packages[0].shasum = '9'.repeat(40))],
    ['core metadata URL', (value) => (value.registry.packages[0].metadataUrl = 'https://registry.npmjs.org/core')],
    ['core tarball URL', (value) => (value.registry.packages[0].tarballUrl = 'https://registry.npmjs.org/core.tgz')],
    ['addon integrity', (value) => (value.registry.packages[1].integrity = `sha512-${Buffer.alloc(64, 8).toString('base64')}`)],
    ['addon shasum', (value) => (value.registry.packages[1].shasum = '8'.repeat(40))],
    ['consumer name', (value) => (value.consumer.name = '@fablebook/other')],
    ['consumer location', (value) => (value.consumer.location = 'repository')],
    ['consumer external flag', (value) => (value.consumer.directoryOutsideRepository = false)],
    ['consumer dependencies', (value) => (value.consumer.dependencies[PACKAGE_SPECS[0].name] = '1.0.0')],
    ['consumer registry', (value) => (value.consumer.registryOrigin = 'https://registry.npmjs.org/')],
    ['consumer resolution', (value) => (value.consumer.lockfileResolution = 'workspace')],
    ['consumer workspace flag', (value) => (value.consumer.workspaceResolution = true)],
    ['consumer result', (value) => (value.consumer.result = 'failed')],
    ['step command', (value) => (value.steps[0].command = 'npm ci')],
    ['step duration', (value) => (value.steps[0].durationMs = -1)],
    ['cleanup result', (value) => (value.cleanup.result = 'failed')],
    ['registry cleanup', (value) => (value.cleanup.registryStopped = false)],
    ['worktree cleanup', (value) => (value.cleanup.temporaryWorktreeRemoved = false)],
    ['storage cleanup', (value) => (value.cleanup.registryStateRemoved = false)],
    ['credential cleanup', (value) => (value.cleanup.credentialStateRemoved = false)],
    ['consumer cleanup', (value) => (value.cleanup.consumerStateRemoved = false)],
    ['cache cleanup', (value) => (value.cleanup.npmCacheRemoved = false)],
    ['omitted field', (value) => delete value.registry.packages[0].shasum],
    ['unexpected field', (value) => (value.unexpected = true)],
  ];
  for (const [label, forge] of forgeries) {
    const forged = structuredClone(expected);
    forge(forged);
    assert.throws(() => validateEvidenceBinding(forged, expected), undefined, `${label} was accepted`);
  }
});

function githubFixture() {
  const stagedSha = 'a'.repeat(40);
  const sourceSha = 'b'.repeat(40);
  const mainSha = 'c'.repeat(40);
  const actor = { id: 7, login: 'maintainer' };
  const repository = { id: 1301358254, full_name: REPOSITORY };
  const pull = {
    number: 1,
    state: 'open',
    draft: false,
    head: { repo: { full_name: REPOSITORY }, ref: STAGED_LINE, sha: stagedSha },
    base: { repo: { full_name: REPOSITORY }, ref: RELEASE_LINE, sha: sourceSha },
    title: 'not authority',
    body: 'not authority',
  };
  return {
    stagedSha, sourceSha, mainSha,
    pull,
    snapshot: {
      eventName: 'workflow_run',
      event: {
        action: 'completed', repository, sender: actor,
        workflow_run: {
          id: 88, name: 'Ready release QA signal', event: 'pull_request', status: 'completed', conclusion: 'success',
          head_branch: STAGED_LINE, repository, head_repository: repository, actor, triggering_actor: actor,
        },
      },
      stagedRefSha: stagedSha,
      sourceRefSha: sourceSha,
      pulls: [pull],
      localHead: mainSha,
      mainRefSha: mainSha,
      expectedDispatchSha: mainSha,
      expectedWorkflowSha: mainSha,
    },
  };
}

test('GitHub authority requires the one current same-repository release PR and refs', () => {
  const { snapshot } = githubFixture();
  const authority = validateGitHubAuthoritySnapshot(snapshot);
  assert.equal(authority.mode, 'github-current');
  assert.equal(authority.pullRequest.number, 1);

  const failures = [
    ['stale checkout', (value) => (value.localHead = 'd'.repeat(40))],
    ['stale workflow SHA', (value) => (value.expectedWorkflowSha = 'd'.repeat(40))],
    ['wrong event repo', (value) => (value.event.repository.full_name = 'storybookjs/storybook')],
    ['spoofed signal name', (value) => (value.event.workflow_run.name = 'Ready release QA controller')],
    ['wrong signal event', (value) => (value.event.workflow_run.event = 'workflow_dispatch')],
    ['side-branch head', (value) => (value.pulls[0].head.ref = 'side/branch')],
    ['wrong head repo', (value) => (value.pulls[0].head.repo.full_name = 'fork/lab-01')],
    ['wrong base ref', (value) => (value.pulls[0].base.ref = 'main')],
    ['wrong base repo', (value) => (value.pulls[0].base.repo.full_name = 'fork/lab-01')],
    ['mismatched current staged ref', (value) => (value.stagedRefSha = 'c'.repeat(40))],
    ['mismatched current source ref', (value) => (value.sourceRefSha = 'c'.repeat(40))],
    ['missing PR', (value) => (value.pulls = [])],
    ['multiple PRs', (value) => value.pulls.push(structuredClone(value.pulls[0]))],
    ['draft PR', (value) => (value.pulls[0].draft = true)],
  ];
  for (const [label, mutate] of failures) {
    const value = structuredClone(snapshot);
    mutate(value);
    assert.throws(() => validateGitHubAuthoritySnapshot(value), undefined, `${label} was accepted`);
  }

  const dispatch = structuredClone(snapshot);
  dispatch.eventName = 'workflow_dispatch';
  dispatch.event = { repository: snapshot.event.repository, sender: snapshot.event.sender, inputs: {} };
  assert.equal(validateGitHubAuthoritySnapshot(dispatch).event, 'workflow_dispatch');
  assert.deepEqual(validateReadyQaWakeup({ eventName: 'workflow_dispatch', event: dispatch.event }), { event: 'workflow_dispatch', actor: 'maintainer' });
});

test('isolated npm environment ignores ambient registry, auth, proxy, and config inputs', async () => {
  await withTemporaryDirectory('lab-01-env-test-', async (directory) => {
    const maliciousKeys = {
      HOME: '/tmp/ambient-home',
      'npm_config_@fablebook:registry': 'http://127.0.0.1:9/',
      NPM_CONFIG_USERCONFIG: '/tmp/ambient-userconfig',
      NODE_AUTH_TOKEN: 'ambient-token',
      NPM_TOKEN: 'ambient-token',
      HTTPS_PROXY: 'http://127.0.0.1:9/',
    };
    const previous = Object.fromEntries(Object.keys(maliciousKeys).map((key) => [key, process.env[key]]));
    Object.assign(process.env, maliciousKeys);
    try {
      const origin = 'http://127.0.0.1:4873/';
      const env = await createIsolatedNpmEnvironment({
        tempRoot: directory,
        name: 'test',
        registryOrigin: origin,
      });
      assert.equal(env.NPM_CONFIG_REGISTRY, origin);
      assert.equal(env.HOME, join(directory, 'isolated-home'));
      assert.notEqual(env.NPM_CONFIG_USERCONFIG, maliciousKeys.NPM_CONFIG_USERCONFIG);
      assert.equal(env.NODE_AUTH_TOKEN, undefined);
      assert.equal(env.NPM_TOKEN, undefined);
      assert.equal(env.HTTPS_PROXY, undefined);
      assert.equal(env['npm_config_@fablebook:registry'], undefined);
      assert.deepEqual(Object.keys(env).sort(), [
        'CI',
        'HOME',
        'NO_COLOR',
        'NPM_CONFIG_AUDIT',
        'NPM_CONFIG_CACHE',
        'NPM_CONFIG_FETCH_RETRIES',
        'NPM_CONFIG_FUND',
        'NPM_CONFIG_GLOBALCONFIG',
        'NPM_CONFIG_REGISTRY',
        'NPM_CONFIG_UPDATE_NOTIFIER',
        'NPM_CONFIG_USERCONFIG',
        'PATH',
        'TEMP',
        'TMP',
        'TMPDIR',
        'USERPROFILE',
      ]);
      const config = await readFile(env.NPM_CONFIG_USERCONFIG, 'utf8');
      assert.match(config, /^registry=http:\/\/127\.0\.0\.1:4873\//m);
      assert.match(config, /^@fablebook:registry=http:\/\/127\.0\.0\.1:4873\//m);
      assert.doesNotMatch(config, /token|proxy|registry\.npmjs\.org|127\.0\.0\.1:9/);
      assert.equal(await readFile(env.NPM_CONFIG_GLOBALCONFIG, 'utf8'), '');
      await assert.rejects(
        createIsolatedNpmEnvironment({
          tempRoot: directory,
          name: 'unsafe',
          registryOrigin: origin,
          additions: { npm_config_registry: 'https://registry.npmjs.org/' },
        }),
        /unsafe npm environment addition/,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('Ready QA uses a read-only signal and exact default-main controller with inert candidate materialization', async () => {
  const signal = await readFile(
    new URL('../.github/workflows/ready-release-qa.yml', import.meta.url),
    'utf8',
  );
  assert.match(signal, /^name: Ready release QA signal$/m);
  assert.match(signal, /^permissions: \{\}$/m);
  assert.doesNotMatch(signal, /actions\/checkout|setup-node|upload-artifact|node scripts|contents: read|pull-requests: read|workflow_dispatch/);

  const controller = await readFile(new URL('../.github/workflows/ready-release-qa-controller.yml', import.meta.url), 'utf8');
  assert.match(controller, /workflow_run:\n    workflows:\n      - Ready release QA signal/);
  assert.match(controller, /^  workflow_dispatch:$/m);
  assert.match(controller, /^permissions: \{\}$/m);
  assert.match(controller, /permissions:\n      contents: read\n      pull-requests: read/);
  assert.doesNotMatch(controller, /contents: write|pull-requests: write|actions: write/);
  assert.match(controller, /actions\/checkout@[0-9a-f]{40} # v6/);
  assert.match(controller, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(controller, /persist-credentials: false/);
  assert.match(controller, /EXPECTED_DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(controller, /EXPECTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(controller, /--authority github-current/);
  assert.match(controller, /uses: actions\/setup-node@[0-9a-f]{40} # v6/);
  assert.match(controller, /uses: actions\/upload-artifact@[0-9a-f]{40} # v6/);
  assert.match(controller, /ready-release-qa-\$\{\{ steps\.qa\.outputs\.staged-sha/);
  assert.doesNotMatch(controller, /path: candidate|pull_request\.head\.sha|staged_sha:|source_sha:/);
});

test('temporary QA state is cleaned even when work fails', async () => {
  let directory;
  await assert.rejects(
    withTemporaryDirectory('lab-01-cleanup-test-', async (path) => {
      directory = path;
      await writeFile(join(path, 'registry-residue'), 'temporary');
      throw new Error('injected failure');
    }),
    /injected failure/,
  );
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('authoritative QA always writes a sanitized failure artifact without private diagnostics', async () => {
  await withTemporaryDirectory('lab-01-qa-failure-evidence-', async (directory) => {
    const evidence = join(directory, 'evidence.json');
    await assert.rejects(qaMain([
      '--authority', 'local', '--repository', REPOSITORY,
      '--staged-sha', 'a'.repeat(40), '--source-sha', 'b'.repeat(40),
      '--evidence', evidence,
    ]), /READY_QA_FAILED/);
    assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')), {
      schemaVersion: 2,
      repository: REPOSITORY,
      operation: 'ready-release-qa',
      status: 'failed',
      error: { code: 'READY_QA_FAILED' },
    });
  });
});
