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
   PR in place while preserving whether it is draft or ready. A manual workflow
   dispatch is the recovery wake-up.
5. Closing the current release PR without merging creates a fresh structured
   empty intent commit and one new draft PR. The closed PR remains untouched as
   the historical review and comment record. The first live transition closed
   PR #1 and created draft PR #12.

The maintainer re-reads both remote refs and the matching open release PR before
acting. It accepts only this repository, release line, staged line, fixed
`1.0.1` target, and one matching open draft-or-ready PR. A stale staged intent is
replaced using an expected-old guarded ref update; a concurrent release-line
advance causes the run to stop so a later wake-up can include the newer fix.
`node scripts/maintain-release-draft.mjs --dry-run` validates and reports the
current action without creating a commit, changing a ref, or editing the PR.

The close handler treats `pull_request_target` deliveries only as wake-ups. It
accepts the exact same-repository `staged/v1.0` to `releases/v1.0` identity,
checks out only trusted `releases/v1.0` code, and re-reads the refs and current
PR history. A merged release PR never regenerates. Unrelated events do nothing;
ordinary fix PRs whose head is not `staged/v1.0` are unrelated even when they
target the release line. A staged head with the wrong base or repository, a
fork, and ambiguous state fail closed. After the
triggering event is matched to the same historical PR and closed head, the
latest durable lifecycle PR decides the action. A latest merged PR is a no-op;
a latest closed, unmerged PR gets a replacement even when an older close was
the wake-up. A latest open PR counts as the replacement only when it is a draft
at the exact current staged intent and that intent is current for the release
line; stale or otherwise unexpected open state fails closed.

Before reusing the same head/base pair, the handler writes a fresh empty intent
commit. The write uses `--force-with-lease` with the exact observed old staged
SHA. Both refs are checked immediately before and after the write, and any
concurrent release or staged advance restarts state derivation. Replacement PR
creation always sends `draft: true` and uses the same generated body as normal
draft maintenance.

The workflow is live from the default branch. With organization-level
Actions-created PR authority enabled, [run 29414470336](https://github.com/fablebookjs/lab-01/actions/runs/29414470336)
closed historical PR #1, moved `staged/v1.0` from the closed intent to a fresh
expected-old guarded empty intent, and created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12).
Attempt 2 of the same run returned `replacement-exists`; exactly one matching
open release PR remained.

Merging the current validated release PR is explicit authorization to publish
its exact source. **Do not merge today's draft PR:** the public `1.0.0`
baseline, npm trusted-publisher settings, GitHub environment, and fresh QA for
the manifest-hardened head are still external gates.

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

## Live QA and remaining gate

Ready-state exact-version QA is live. A human `ready_for_review` event runs it
for that exact staged head. A staged update made with the built-in token creates
an approval-required synchronize run, so release-PR maintenance explicitly
dispatches the fixed `ready-release-qa.yml` workflow at `staged/v1.0` after the
new head and PR body converge. `workflow_dispatch` is the documented GitHub
exception that creates a run from a built-in-token request. The first
GitHub-current proof is
[run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684);
every refreshed ready head needs its own successful proof.

Close-and-regenerate is live. [Run 29414470336](https://github.com/fablebookjs/lab-01/actions/runs/29414470336)
created the clean draft replacement, and its duplicate attempt converged on the
same PR without another ref or PR write.

Branch reconciliation, tagging `v1.0.1`, and creating a GitHub Release remain
intentionally **OUTSIDE THIS PREPARATION SLICE**. The draft maintainer does not
execute pull-request-head code, and no workflow may mutate a Storybook
resource.

## Offline trusted-publishing preparation

Both publishable package manifests carry the same exact Git repository URL,
their monorepo directory, and the minimal `src` files allowlist. They contain no
`publishConfig`, registry, provenance, or authentication override. The add-on
continues to use an exact core dependency, which the version transform changes
from `1.0.0` to `1.0.1` together with the four allowlisted manifest/lock files.

Snapshot preparation and npm publication are separate workflows:

1. `.github/workflows/prepare-release-snapshot.yml` is manually dispatched on
   `releases/v1.0` with an exact merged release-PR number and successful
   ready-QA run ID. Those inputs are expectations, not authority. The script
   re-reads the PR, run, artifact list, release line, and snapshot ref.
2. The merged PR must be the same-repository `staged/v1.0` to
   `releases/v1.0` proposal. Its merge `M` has ordered parents `[S, I]`; `I` is
   the one-parent empty structured intent for `S`; and `M` has the sealed source
   tree. Squash, rebase, wrong-parent, wrong-tree, stale-QA, duplicate artifact,
   and ambiguous state fail closed.
3. The specified QA artifact is untrusted input. Snapshot preparation
   independently reproduces the exact four-file transform, Git tree, content
   hash, package file lists, SHA-512 integrity, and SHA-1 shasum using Node
   `24.18.0` and npm `11.18.0`. Every identity must equal the QA evidence.
4. `V` is a deterministic single-parent commit over `M`. Its structured
   metadata binds line, version, `M`, QA run, staged/source SHAs, and both
   package hashes. Only `refs/heads/release-snapshots/v1.0.1` may be created,
   using an exact absent-ref lease. The exact existing `V` is reused; any other
   value stops. This ref is a durable locator for `V`, not a second release
   line. `releases/v1.0` must be byte-for-byte unchanged across the run.
5. Snapshot evidence schema 1 records the authority SHAs, run/artifact,
   transform identities, `V`, both package file/hash identities, ref result,
   and the unchanged release-line boundary. It contains no credential.

`.github/workflows/publish-npm.yml` is the single stable npm trusted-publisher
identity for both packages. It has only a top-level manual dispatch with the
fixed choice `core` or `addon`, runs on GitHub-hosted `ubuntu-24.04`, and grants
its job only `contents: read` and `id-token: write`. Checkout and setup-node are
pinned by full v6 commit SHA. The job uses environment `npm-publish`, Node
`24.18.0`, and exact npm `11.18.0`.

For this single-operator G1 laboratory, `npm-publish` is an exact OIDC subject
and requires no second-person reviewer. It may have zero required reviewers;
the explicit manual dispatch is the operator authorization. Do not infer that
policy for production. The environment contains no npm secret. On npmjs.com,
both packages must configure `fablebookjs` / `lab-01` / `publish-npm.yml` /
`npm-publish` with **npm publish only**. Staged publishing is not part of G1.

The publisher rejects `NPM_TOKEN` and `NODE_AUTH_TOKEN`, inherits neither, and
creates closed temporary user/global npm configuration with only the exact
public registry and provenance enabled. It revalidates `V`, `M`, `S`, `I`, the
current release line, manifests, package file allowlists, and both packed
hashes before reading npm. An existing package is reusable only when repository,
integrity, shasum, and downloaded tarball bytes equal `V`; mismatch is a
permanent stop. Add-on publication requires exact matching public core
`1.0.1`. A lost publish response is accepted only after exact registry
read-back.

Publisher evidence schema 1 binds the run choice, `S`/`I`/`M`/`V`, QA run,
package file/hash identities, before/after npm state, downloaded registry
identity, and unchanged release line. It explicitly records that no traditional
token, reconciliation, tag, or GitHub Release mutation occurred.

The accepted issue #14 state contract requires publication to complete before
normal reconciliation or conflict recovery begins. Consequently this slice
never reconciles the release line while either package is absent and never
creates `v1.0.1`, a GitHub Release, or a `1.0.2` proposal.
