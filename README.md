# Fablebook `lab-01`

`lab-01` is a disposable, synthetic monorepo for proving a visible release-PR
contract without touching Storybook resources. The bounded G1 proof uses only
the two public synthetic packages named below.

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
it is draft or ready. Closing an unmerged release PR now automatically creates
one fresh empty intent and a new draft replacement. The first live transition
closed PR #1 and created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12);
rerunning the same delivery recognized the existing replacement without
creating another PR.

See [the release-process note](docs/release-process.md) for the current contract
and explicit automation limits.

Ready-state package QA is implemented as a read-only exact-snapshot check. It
materializes `1.0.1` only in a temporary worktree, publishes only the two
synthetic candidates to loopback Verdaccio, installs them into a temporary
non-workspace consumer, records sanitized identity and integrity evidence, and
then removes the worktree, registry process, and registry storage. It does not
publish to public npm or mutate GitHub state.

The checked-in workflow first checks out pinned trusted QA-controller code from
the release line and bootstraps its closed toolchain. It then materializes the
exact staged commit as candidate data with full history and rederives the one
current ready PR and both current refs through the read-only GitHub API. A
manual dispatch supplies no SHA authority. Local proofs must instead pass
`--authority local`; their evidence is explicitly non-GitHub-current. Marking
the current proposal ready runs the automatic QA path. When a ready proposal is
refreshed by the built-in token, release-PR maintenance explicitly dispatches
QA for the new staged head because the resulting synchronize run otherwise
requires human approval. The first GitHub-current proof is
[run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684).
Close-and-regenerate is live; its first replacement proof created PR #12 and
converged on that same replacement during a duplicate attempt.

The pinned Verdaccio toolchain is bootstrapped separately from the candidate.
Candidate, publish, and consumer npm subprocesses receive closed environments,
isolated home/config/cache paths, and both default and `@fablebook` registries
pinned to the generated loopback origin. Candidate installation omits the
development-only QA toolchain and cannot use public npm.

The issue #19 preparation adds two deliberately separate public-release
surfaces. `Prepare release snapshot` runs from exact current default `main` and
may create only the deterministic `release-snapshots/v1.0.1` locator after
validating the unique latest merged release intent `M`, the latest successful
exact-head ready-QA authorization, and a fresh isolated regeneration. The run
ID is not part of `V`, so equivalent current QA runs converge. `Publish npm
package` is the one stable OIDC publisher identity. It also runs only exact
current-main code, treats `V` as inert Git data, independently reconstructs the
allowed tree from `M`, and can publish or reuse only `core` first and then
`addon`. It cannot execute candidate code, move the release line, tag, create a
GitHub Release, or create the next proposal. Late descendants of `M` do not
block incomplete package publication.

This preparation is not permission to merge the current draft PR or publish.
The exact `1.0.0` packages must first be published interactively, the two npm
trusted publishers and `npm-publish` GitHub environment must be configured by a
human, and PR #12 must be refreshed and receive current-head QA after these
manifest changes.
