import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  PACKAGE_SPECS,
  RELEASE_VERSION,
  REPOSITORY,
  TRANSFORMED_FILES,
  assertRegistryOnlyConsumerLock,
  transformCandidate,
  validateEvidenceBinding,
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

test('stale or mismatched QA evidence fails closed', () => {
  const identity = {
    stagedSha: '1'.repeat(40),
    sourceSha: '2'.repeat(40),
    sourceTree: '3'.repeat(40),
    transformedTree: '4'.repeat(40),
    transformedContentSha256: '5'.repeat(64),
  };
  const evidence = {
    schemaVersion: 1,
    repository: REPOSITORY,
    release: { version: RELEASE_VERSION, ...identity },
    registry: {
      origin: 'http://127.0.0.1:4873/',
      packages: PACKAGE_SPECS.map(({ name }) => ({ name, version: RELEASE_VERSION, integrity })),
    },
    consumer: { result: 'passed', workspaceResolution: false },
    cleanup: { result: 'passed' },
  };
  assert.doesNotThrow(() => validateEvidenceBinding(evidence, identity));
  assert.throws(
    () => validateEvidenceBinding(evidence, { ...identity, stagedSha: '6'.repeat(40) }),
    /stagedSha/,
  );
  assert.throws(
    () => validateEvidenceBinding(evidence, { ...identity, transformedTree: '7'.repeat(40) }),
    /transformedTree/,
  );
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
