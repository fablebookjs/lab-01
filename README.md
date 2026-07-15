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
that same PR from the exact current release-line head while preserving whether
it is draft or ready. A separate,
locally tested workflow is ready for later default-branch installation to
replace a closed, unmerged release PR with a clean draft; it is not enabled or
calibrated against GitHub authority in this branch.

See [the release-process note](docs/release-process.md) for the current contract
and explicit automation limits.

Ready-state package QA is implemented as a read-only exact-snapshot check. It
materializes `1.0.1` only in a temporary worktree, publishes only the two
synthetic candidates to loopback Verdaccio, installs them into a temporary
non-workspace consumer, records sanitized identity and integrity evidence, and
then removes the worktree, registry process, and registry storage. It does not
publish to public npm or mutate GitHub state.

The checked-in workflow first uses `actions/checkout` read authority to
materialize the exact staged commit with full history, then rederives the one
current ready PR and both current refs through the read-only GitHub API. A
manual dispatch supplies no SHA authority. Local proofs must instead pass
`--authority local`; their evidence is explicitly non-GitHub-current. Marking
the current proposal ready runs the automatic QA path. When a ready proposal is
refreshed by the built-in token, release-PR maintenance explicitly dispatches
QA for the new staged head because the resulting synchronize run otherwise
requires human approval. The first GitHub-current proof is
[run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684).
Close-and-regenerate is installed, but the Fablebook organization policy must
allow Actions-created PRs before its replacement creation can be calibrated.

The pinned Verdaccio toolchain is bootstrapped separately from the candidate.
Candidate, publish, and consumer npm subprocesses receive closed environments,
isolated home/config/cache paths, and both default and `@fablebook` registries
pinned to the generated loopback origin. Candidate installation omits the
development-only QA toolchain and cannot use public npm.
