# Release process

## Current proof slice

This repository currently demonstrates only the first visible release intent:

1. `main` and tag `v1.0.0` identify the synthetic `1.0.0` baseline;
   `releases/v1.0` contains that baseline and the fixes proposed for `1.0.1`.
2. `staged/v1.0` adds one empty commit whose structured trailers identify
   `releases/v1.0`, proposed version `1.0.1`, and the full source commit SHA.
3. A draft PR from `staged/v1.0` to `releases/v1.0` presents that intent for
   review. The commit trailers, parent, and unchanged tree are authoritative;
   the editable PR title and body are not.
4. A push to `releases/v1.0` automatically refreshes `staged/v1.0` with a new
   empty intent based on the exact current line head and updates the existing
   draft PR in place. A manual workflow dispatch is the recovery wake-up.

The maintainer re-reads both remote refs and the matching open draft PR before
acting. It accepts only this repository, release line, staged line, fixed
`1.0.1` target, and one matching open draft PR. A stale staged intent is
replaced using an expected-old guarded ref update; a concurrent release-line
advance causes the run to stop so a later wake-up can include the newer fix.
`node scripts/maintain-release-draft.mjs --dry-run` validates and reports the
current action without creating a commit, changing a ref, or editing the PR.

In the future contract, merging the current validated release PR is explicit
authorization to publish its exact source. **Do not merge today's PR:** no
publication or reconciliation automation exists in this slice.

## Ready-state exact-version QA

Ready or refreshed-ready proposals may run the read-only `Ready release QA`
workflow. The workflow treats its event only as a wake-up and validates the
full staged commit and source commit directly. The staged commit must be the
structured one-parent empty intent for exact version `1.0.1`; PR title and body
are never inputs.

The runner creates a detached temporary worktree at the exact source. Its only
candidate changes are the root, core, and add-on manifest versions; the exact
add-on-to-core dependency; and the corresponding lockfile fields. It installs,
tests with an explicit `LAB_01_EXPECTED_PACKAGE_VERSION=1.0.1` contract, runs
any declared builds, and packs the two allowlisted packages. Ordinary source
tests default to strict `1.0.0` assertions; candidate QA does not skip them. A
pinned `verdaccio@6.8.0` listens only on `127.0.0.1`, has no uplink, and accepts
only `@fablebook/lab-01-core` and `@fablebook/lab-01-addon`. Both packages are
published there at exact version `1.0.1`, then their metadata and downloaded
tarball hashes are checked against the packed candidates.

The final consumer is generated outside the repository and has no workspace
configuration. Its lockfile must resolve both exact versions from the ephemeral
loopback registry, retain the add-on's exact core dependency, and contain no
link, file, or workspace resolution. The retained JSON evidence binds the
staged SHA, source SHA and tree, transformed Git tree and content hash, package
names and integrities, loopback metadata/tarball URLs, consumer result, step
durations, and successful cleanup. Evidence for another staged SHA, source, or
transformed identity fails closed.

The workflow has only `contents: read`, does not persist checkout credentials,
and performs no GitHub or public npm write. All worktrees, processes, registry
storage, generated credentials/configuration, packages, and consumer files are
temporary; only sanitized evidence is retained.

## Not yet automated

The following lifecycle stages are intentionally **NOT YET AUTOMATED**:

- replacing a closed, unmerged proposal;
- publishing packages, reconciling branches, tagging `v1.0.1`, or creating a
  GitHub Release.

Those stages are follow-on work. This slice does not publish to npm, create a
`v1.0.1` tag or GitHub Release, or mutate any Storybook resource. The draft
maintainer does not execute pull-request-head code.
