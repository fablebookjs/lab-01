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
5. The close-and-regenerate handler is implemented for later installation on
   the default branch. When installed, closing the current release PR without
   merging creates a fresh structured empty intent commit and one new draft PR.
   The closed PR remains untouched as the historical review and comment record.

The maintainer re-reads both remote refs and the matching open draft PR before
acting. It accepts only this repository, release line, staged line, fixed
`1.0.1` target, and one matching open draft PR. A stale staged intent is
replaced using an expected-old guarded ref update; a concurrent release-line
advance causes the run to stop so a later wake-up can include the newer fix.
`node scripts/maintain-release-draft.mjs --dry-run` validates and reports the
current action without creating a commit, changing a ref, or editing the PR.

The close handler treats `pull_request_target` deliveries only as wake-ups. It
accepts the exact same-repository `staged/v1.0` to `releases/v1.0` identity,
checks out only trusted `releases/v1.0` code, and re-reads the refs and current
PR history. A merged release PR never regenerates. Unrelated events do nothing;
fork, partial release-PR identities, reopened historical PRs, and ambiguous
state fail closed. A delayed close for an older PR cannot alter a newer PR, and
a duplicate delivery recognizes an existing open draft replacement rather than
creating another one.

Before reusing the same head/base pair, the handler writes a fresh empty intent
commit. The write uses `--force-with-lease` with the exact observed old staged
SHA. Both refs are checked immediately before and after the write, and any
concurrent release or staged advance restarts state derivation. Replacement PR
creation always sends `draft: true` and uses the same generated body as normal
draft maintenance.

The workflow is deliberately not live merely because it exists on this local
branch: `pull_request_target` installation on the default branch, built-in token
PR-creation authority, event behavior, actor, input/output SHAs, and branch-rule
behavior still require controlled GitHub calibration before the first demo.

In the future contract, merging the current validated release PR is explicit
authorization to publish its exact source. **Do not merge today's PR:** no
publication or reconciliation automation exists in this slice.

## Ready-state exact-version QA

Ready or refreshed-ready proposals may run the read-only `Ready release QA`
workflow. The workflow treats its event only as a wake-up. For pull-request
events it requires a non-draft, same-repository `staged/v1.0` head and
`releases/v1.0` base. For both pull-request and manual wake-ups it then uses the
read-only GitHub API to rederive the current refs and require exactly one
matching current ready PR. Manual dispatch accepts no SHA inputs. The staged
commit must be the structured one-parent empty intent for exact version
`1.0.1`; PR title and body are never inputs.

`actions/checkout@v7` materializes the exact PR head (or current staged branch
for manual recovery) with full history and tags while it has checkout read
authority, then removes persisted credentials. No anonymous post-checkout Git
fetch is used. The authenticated checkout shape is statically tested, but an
actual GitHub Actions run against the current public laboratory PR is still
required before this workflow is treated as installed proof.

The workflow bootstraps the exactly locked Verdaccio development toolchain from
public npm as a separate trusted-tooling step with scripts disabled and an
empty environment/config. The runner then creates a detached temporary
worktree at the exact source. Its only
candidate changes are the root, core, and add-on manifest versions; the exact
add-on-to-core dependency; and the corresponding lockfile fields. It installs,
tests with an explicit `LAB_01_EXPECTED_PACKAGE_VERSION=1.0.1` contract, runs
any declared builds, and packs the two allowlisted packages. Candidate install
uses `npm ci --omit=dev --offline` with an empty isolated cache and loopback
configuration, so it does not reinstall or contact public npm for the QA
toolchain. Ordinary source tests default to
strict `1.0.0` assertions; candidate QA does not skip them. A pinned
`verdaccio@6.8.0` listens only on `127.0.0.1`, has no uplink, and accepts only
`@fablebook/lab-01-core` and `@fablebook/lab-01-addon`. Both packages are
published there at exact version `1.0.1`, then their metadata and downloaded
tarball hashes are checked against hashes recomputed from the packed bytes.

Every npm subprocess is built from a small environment allowlist. The runner
does not inherit npm configuration, scoped registries, credentials, proxy
settings, home directories, or user/global config. It creates isolated home,
temporary, cache, user-config, and global-config paths and pins both the default
and `@fablebook` registries to the generated loopback origin. Publisher auth is
generated locally, scoped to the disposable registry, never passed to the
candidate or consumer, and deleted with the temporary root.

The final consumer is generated outside the repository and has no workspace
configuration. Its lockfile must resolve both exact versions from the ephemeral
loopback registry, retain the add-on's exact core dependency, and contain no
link, file, or workspace resolution. Evidence schema 2 distinguishes explicit
`local` authority from `github-current` authority, so an unreferenced local
intent cannot claim to represent the live PR. The retained JSON evidence is an
exact deep match against a separately assembled runtime contract. It binds the
authority and current refs/PR (when applicable), staged SHA, source SHA and
tree, transformed Git tree and content hash, exact transformation, registry
version/configuration, package SHA-512 and SHA-1 values, exact loopback
metadata/tarball URLs, external consumer contract, step results, and every
cleanup assertion. Omitted, unexpected, stale, or one-field-forged evidence
fails closed.

The workflow has only `contents: read` and `pull-requests: read`, does not
persist checkout credentials, and performs no GitHub or public npm write. All worktrees, processes, registry
storage, generated credentials/configuration, packages, and consumer files are
temporary; only sanitized evidence is retained.

## Not yet live or implemented

Ready-state exact-version QA and close-and-regenerate are implemented and
tested locally, but neither workflow is installed on the default branch or
calibrated against the current release PR. Do not mark the PR ready or close it
for a lifecycle demonstration until that controlled installation is complete.

Public package publication, branch reconciliation, tagging `v1.0.1`, and
creating a GitHub Release are intentionally **NOT YET IMPLEMENTED**. This slice
does not publish to public npm, create a `v1.0.1` tag or GitHub Release, or
mutate any Storybook resource. The draft maintainer does not execute
pull-request-head code.
