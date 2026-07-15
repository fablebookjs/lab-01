import { add } from '@fablebook/lab-01-core';

export function total(values) {
  return values.reduce((sum, value) => add(sum, value), 0);
}
