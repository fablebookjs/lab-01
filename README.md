# Fablebook `lab-01`

`lab-01` is a disposable, synthetic monorepo for proving a visible release-PR
contract without touching Storybook resources or publishing real packages.

**Demo:** follow the outcome-first [five-minute screen-share script](docs/demo.md)
or open the public [release-state explorer](https://fablebookjs.github.io/release-state-explorer/).

The `1.0.0` baseline contains:

- `@fablebook/lab-01-core`;
- `@fablebook/lab-01-addon`, with an exact dependency on core `1.0.0`; and
- an isolated consumer manifest pinned to both packages at `1.0.0`.

Install and run the baseline tests with:

```sh
npm install
npm test
```

The first draft release PR proposes `1.0.1` from a structured empty commit on
`staged/v1.0`. Its base is `releases/v1.0`, which initially points to the same
commit as `main` and tag `v1.0.0`.

See [the release-process note](docs/release-process.md) for the current contract
and explicit automation limits.

GitHub authority for normal post-publication reconciliation is tested separately
on [fixed calibration refs](docs/reconciliation-calibration.md), so the completed
release-PR demonstration remains intact.

The destructive conflict path has a separate
[fixed-ref recovery calibration](docs/conflict-recovery-calibration.md). It can
retain an intentionally interrupted force and resume it into one draft recovery
PR without targeting the live release line or proposal.

Recovery completion and terminal next-proposal suppression use a third,
[dedicated fixed namespace](docs/recovery-terminal-calibration.md). That probe
requires a human-created, normally merged recovery PR and stops after one draft
empty proposal; finalization and publication remain outside this repository
slice.
