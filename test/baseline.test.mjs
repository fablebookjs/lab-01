import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { total } from '@fablebook/lab-01-addon';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('the baseline packages run together', () => {
  assert.equal(total([1, 2, 3]), 6);
});

test('the add-on and isolated consumer use exact 1.0.0 dependencies', async () => {
  const addon = await readJson(new URL('../packages/addon/package.json', import.meta.url));
  const consumer = await readJson(new URL('../consumer/package.json', import.meta.url));

  assert.equal(addon.dependencies['@fablebook/lab-01-core'], '1.0.0');
  assert.deepEqual(consumer.dependencies, {
    '@fablebook/lab-01-addon': '1.0.0',
    '@fablebook/lab-01-core': '1.0.0',
  });
});
