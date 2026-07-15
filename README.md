# Fablebook `lab-01`

`lab-01` is a disposable, synthetic monorepo for proving a visible release-PR
contract without touching Storybook resources or publishing real packages.

The `1.0.0` baseline contains:

- `@fablebook/lab-01-core`;
- `@fablebook/lab-01-addon`, with an exact dependency on core `1.0.0`; and
- an isolated consumer manifest pinned to both packages at `1.0.0`.

Install and run the baseline tests with:

```sh
npm install
npm test
```

The draft release PR proposes `1.0.1` from a structured empty commit on
`staged/v1.0`. Its base is `releases/v1.0`, which started at the same commit as
`main` and tag `v1.0.0`. Pushes to the release line now automatically refresh
that same draft PR from the exact current release-line head.

See [the release-process note](docs/release-process.md) for the current contract
and explicit automation limits.
