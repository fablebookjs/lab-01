export function add(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new TypeError('add expects finite numbers');
  }
  return left + right;
}
