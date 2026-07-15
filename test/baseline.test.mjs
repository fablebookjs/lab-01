import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { total } from '@fablebook/lab-01-addon';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const expectedPackageVersion = process.env.LAB_01_EXPECTED_PACKAGE_VERSION ?? '1.0.0';

if (!['1.0.0', '1.0.1'].includes(expectedPackageVersion)) {
  throw new Error('LAB_01_EXPECTED_PACKAGE_VERSION must be exactly 1.0.0 or 1.0.1');
}

test('the baseline packages run together', () => {
  assert.equal(total([1, 2, 3]), 6);
});

test(`package manifests and the add-on edge use exact ${expectedPackageVersion}`, async () => {
  const root = await readJson(new URL('../package.json', import.meta.url));
  const core = await readJson(new URL('../packages/core/package.json', import.meta.url));
  const addon = await readJson(new URL('../packages/addon/package.json', import.meta.url));

  assert.equal(root.version, expectedPackageVersion);
  assert.equal(core.version, expectedPackageVersion);
  assert.equal(addon.version, expectedPackageVersion);
  assert.equal(addon.dependencies['@fablebook/lab-01-core'], expectedPackageVersion);
});

test('the checked-in isolated consumer stays pinned to the 1.0.0 baseline', async () => {
  const consumer = await readJson(new URL('../consumer/package.json', import.meta.url));

  assert.deepEqual(consumer.dependencies, {
    '@fablebook/lab-01-addon': '1.0.0',
    '@fablebook/lab-01-core': '1.0.0',
  });
});
