import assert from 'node:assert/strict';
import test from 'node:test';
import { total } from '@fablebook/lab-01-addon';

test('the installed add-on resolves the installed core package', () => {
  assert.equal(total([1, 2, 3]), 6);
});
