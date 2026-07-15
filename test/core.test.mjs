import assert from 'node:assert/strict';
import test from 'node:test';

import { add } from '@fablebook/lab-01-core';

test('add rejects values that would silently produce a non-finite result', () => {
  assert.throws(() => add(Number.NaN, 1), {
    name: 'TypeError',
    message: 'add expects finite numbers',
  });
  assert.throws(() => add(1, Number.POSITIVE_INFINITY), {
    name: 'TypeError',
    message: 'add expects finite numbers',
  });
});
