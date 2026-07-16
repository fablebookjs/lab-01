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
6. When the uniquely latest lifecycle PR is merged with the exact ordered
   `[source, intent]` graph, the maintainer validates exact `M` or the concrete
   deterministic `V` snapshot and yields ownership without changing
   `staged/v1.0`, PR text, or QA state. H/J remain fail-closed pending the
   finalizer's durable observer/schema.
7. When the finalizer later creates one exact draft `1.0.2` proposal from the
   current line, the maintainer validates and yields to that proposal instead
   of applying the fixed G1 `1.0.1` refresh or QA behavior.

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

The new issue #19 surfaces described below are present only in this offline
integration. The manual operator-only exact `1.0.0` bootstrap exists but has
not published. The trusted-main `V` preparation and direct-OIDC publisher also
exist locally but are not installed or live. No public package, finalization,
or new live-workflow state is claimed by this changeset.

## One-time public baseline bootstrap

The synthetic public `1.0.0` baseline is prepared separately from the patch
release. From a clone whose `origin` is exactly `fablebookjs/lab-01`, inspect
the non-mutating plan first:

```sh
node scripts/bootstrap-npm-baseline.mjs --preflight
```

The script resolves `v1.0.0` once and requires exact commit
`b59edf1d4c0fff51295327e8ce9e72678c336156` and tree
`c17e4b63e8fd8b0bff28e1b9e24caa203d29d80e`. It archives only that resolved
commit—not the mutable tag name or current release branch—and rejects any
repository, package, version, package order, project `.npmrc`, or package
publication override outside its fixed contract. Core is packed before the
add-on. The default registry and `@fablebook` scope are both bound to
`https://registry.npmjs.org/` in isolated config and command arguments.
Every Git identity/object read disables replacement objects and uses a closed
Git environment that cannot inherit object, alternate-object, repository, or
config redirection. The reviewed SHA-512 and SHA-1 values for both package
tarballs are fixed in the allowlist as an independent byte-level guard.

Each packed manifest is re-read from its tarball. SHA-512 SRI and SHA-1 are
calculated from the actual packed bytes, compared with `npm pack` metadata,
and recalculated immediately before publication. Existing or newly published
versions are accepted only when both registry metadata and a freshly
downloaded tarball match those expected hashes. Sanitized output retains the
expected and observed hashes and state without npm credentials, configuration
contents, raw npm diagnostics, or temporary paths. Raw child output is used
only inside the private missing/ambiguous-result classifier; rejected API
errors and generic error serialization receive only sanitized codes, messages,
state, and evidence.

Only the operator may start the mutating mode in an interactive terminal:

```sh
node scripts/bootstrap-npm-baseline.mjs --publish
```

The operator must type the displayed confirmation exactly. The script then
uses npm's interactive web login with a temporary user config and home; it
does not accept inherited npm configuration or credential variables and
removes its config, cache, packed artifacts, and login material on success or
failure. It never writes the repository or the normal `~/.npmrc`.

On `SIGINT`, `SIGTERM`, or `SIGHUP`, the script forwards the signal to the
active login/publish process group where supported, awaits its exit, removes
all temporary npm state, records an interrupted/unknown-registry-state result,
and exits with the same signal semantics. A restart always begins with npm
integrity read-back; it never assumes whether an interrupted publish completed.
`SIGKILL`, host loss, or storage failure cannot guarantee in-process cleanup,
so an operator must remove any surviving `fablebook-npm-bootstrap-*` directory
and rerun `--preflight` before resuming.

Publication is bounded to `@fablebook/lab-01-core@1.0.0` followed by
`@fablebook/lab-01-addon@1.0.0`, always with public access. If core exists and
matches, a rerun skips it and continues with the add-on. An existing mismatch
or incomplete registry response stops without overwrite; after any failure,
rerun `--preflight` before deciding whether to resume. This bootstrap does not
publish `1.0.1`, merge the release PR, or alter any Git ref, tag, Release,
workflow, Pages setting, or Storybook resource.

This operator-only `1.0.0` bootstrap is the sole prepared manual public-npm
write path, and it has not been run to publish either baseline package. No
workflow invokes it.

A validated release-PR merge is the intended authorization input for a
separately reviewed issue #19 finalizer. This maintainer does not publish or
reconcile, no finalizer is installed here, and the operator gate remains closed
while the required external state is absent.

## Maintainer-to-finalizer ownership handoff

Events remain wake-ups. If no current lifecycle PR is open, the maintainer reads
complete paginated all-state PR history and requires one unique latest lifecycle
PR. That PR must be merged—not merely closed—from the same repository's
`staged/v1.0` into `releases/v1.0`. Its staged head must still be the staged ref;
the intent must be the exact one-parent empty `1.0.1` intent; and merge `M` must
have ordered parents `[source, intent]` and the sealed source tree.

The current release line may currently be:

- exact `M`;
- deterministic snapshot `V` at `release-snapshots/v1.0.1`, with one parent
  `M` and the exact structured snapshot trailers.

H/J ownership is intentionally pending because the finalizer's committed
durable observer and reconciliation marker schema are not settled yet. The
maintainer does not accept caller-authored facts or infer those states from
arbitrary ancestry; H/J therefore fail closed. Missing pages, duplicate
or malformed lifecycle PRs, a closed-unmerged latest PR, stale staged state,
wrong versions, unexplained line heads, or contradictory M/V evidence fail
closed.

Every accepted M/V finalizer-owned state returns before staged/ref/PR-body/QA
writes. An exact next proposal is accepted only when it is the unique latest
open lifecycle PR, remains draft, its PR base SHA equals the current release
head, and its empty `1.0.2` intent has that exact source and unchanged tree.
Before returning, the maintainer repeats the complete bounded all-state history
snapshot, rehydrates the latest lifecycle PR, and reclassifies every exact
identity; a created, closed, reordered, or changed PR fails the run.

## Ready-state exact-version QA

Ready or refreshed-ready proposals may run the read-only `Ready release QA`
workflow. The workflow treats its event only as a wake-up. For pull-request
events it requires a non-draft, same-repository `staged/v1.0` head and
`releases/v1.0` base. For both pull-request and manual wake-ups it then uses the
read-only GitHub API to rederive the current refs and require exactly one
matching current ready PR. Manual dispatch accepts no SHA inputs. The staged
commit must be the structured one-parent empty intent for exact version
`1.0.1`; PR title and body are never inputs.

The workflow pins checkout and artifact upload by reviewed full action SHAs. It
first materializes trusted release-line controller code with no persisted
credentials, closes the npm/Git environment, and then checks out the exact PR
head (or current staged branch for manual recovery) with full history as
candidate data. No anonymous post-checkout Git fetch is used.

The workflow bootstraps exact npm and the locked Verdaccio development
toolchain from public npm in a neutral directory with scripts disabled and an
empty isolated environment/config. The runner then creates a detached temporary
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

The workflow and controller files in this section are locally verified
preparation only. They are not installed on default `main`, their trusted
publisher/environment configuration is absent, and they have performed no
public npm or GitHub write.

Both publishable package manifests carry the same exact Git repository URL,
their monorepo directory, and the minimal `src` files allowlist. They contain no
`publishConfig`, registry, provenance, or authentication override. The add-on
continues to use an exact core dependency, which the version transform changes
from `1.0.0` to `1.0.1` together with the four allowlisted manifest/lock files.

Snapshot preparation and npm publication are separate workflows:

1. `.github/workflows/prepare-release-snapshot.yml` is manually dispatched
   from exact current default `main` with the expected latest merged release-PR
   number. An optional ready-QA run ID is only an expectation. The trusted
   controller re-reads all matching lifecycle PRs, successful ready-QA runs,
   the release line, and snapshot ref. Older merged PRs and older equivalent
   successful runs are rejected.
2. The unique latest merged PR must be the same-repository `staged/v1.0` to
   `releases/v1.0` proposal. Its merge `M` has ordered parents `[S, I]`; `I` is
   the one-parent empty structured intent for `S`; and `M` has the sealed source
   tree. Squash, rebase, wrong-parent, wrong-tree, stale-QA, and ambiguous state
   fail closed.
3. The latest successful exact-`I` ready-QA run is retained pre-merge
   authorization evidence, not recoverability authority. Preparation reruns the
   full isolated candidate QA from verified `S` with trusted tooling and then
   independently reconstructs the exact four-file transform from `M`. The Git
   tree, content hash, exact inert package contents, SHA-512 integrity, and
   SHA-1 shasum must agree. An expired or missing retained artifact is recorded
   but does not prevent deterministic regeneration.
4. `V` is a deterministic single-parent commit over `M`. Its structured
   metadata binds line, version, `M`, staged/source SHAs, exact tree/content
   identities, and both package hashes. A run ID is deliberately absent, so
   equivalent current successful QA runs converge on the same commit. Only
   `refs/heads/release-snapshots/v1.0.1` may be created,
   using an exact absent-ref lease. The exact existing `V` is reused; any other
   value stops. This ref is a durable locator for `V`, not a second release
   line. While npm publication is incomplete, `releases/v1.0` may remain at
   `M` or advance to a verified descendant `H`; snapshot preparation itself
   never moves it.
5. Snapshot evidence schema 2 records the latest PR/run authorization,
   retained-artifact availability, regenerated transform identities, `V`, both
   package file/hash identities, ref result, and the observed release-line
   boundary. It contains no credential.

`.github/workflows/publish-npm.yml` is the single stable npm trusted-publisher
identity for both packages. It has only a top-level manual dispatch with the
fixed choice `core` or `addon`, runs on GitHub-hosted `ubuntu-24.04`, and grants
its job only `contents: read` and `id-token: write`. Checkout and setup-node are
pinned by full v6 commit SHA. The job uses environment `npm-publish`, Node
`24.18.0`, and exact npm `11.18.0`.

For this single-operator G1 laboratory, `npm-publish` is an exact OIDC subject
and requires no second-person reviewer. It may have zero required reviewers;
the explicit manual dispatch is the operator authorization. Its deployment
branch rule must allow only the default `main` branch, never the release,
staged, snapshot, tag, or PR refs. Do not infer that policy for production. The
environment contains no npm secret. On npmjs.com,
both packages must configure `fablebookjs` / `lab-01` / `publish-npm.yml` /
`npm-publish` with **npm publish only**. Staged publishing is not part of G1.

The token-bearing job runs only workflow and script code checked out at exact
current default `main`. It binds `github.sha` and `github.workflow_sha` to the
current remote main before publication. It never checks out or executes `V`,
the release/staged refs, PR heads, package scripts, or candidate JavaScript.
Git objects for `S`/`I`/`M`/`V` are fetched as inert data; the trusted publisher
reconstructs the only permitted tree from `M`, rejects every extra file, mode,
symlink, lifecycle script, or manifest field, writes only exact
`package.json` + `src/index.js` package data into a temporary directory, and
packs it with scripts disabled.

Before any npm command, every release workflow rejects project `.npmrc` files
and ambient registry, credential, proxy, TLS, or config inputs. It bootstraps
exact npm `11.18.0` from a neutral directory with empty isolated user/global
configuration, fixed default and `@fablebook` public registries, and no
traditional token. Git advertisement, fetch, and the one snapshot-ref push
likewise use a closed transport/config environment and no tag following.

The publisher revalidates the current line before and after npm work. A clean
or conflicting late descendant `H`/`X` does not block publication; containing
`M` is sufficient while neither reconciliation nor finalization occurs. An
existing package is reusable only when repository, integrity, shasum, and
downloaded tarball bytes equal the independently packed bytes; mismatch is a
permanent stop. Add-on publication requires exact matching public core
`1.0.1`, and addon-present/core-absent is rejected. A lost publish response is
accepted only after exact registry read-back.

Publisher evidence schema 2 is written on success, validation failure,
publication failure, and interruption, then uploaded with `if: always()`. It
contains sanitized fixed error codes and durable npm state without raw child
output, temporary paths, credentials, or configuration. It records that no
candidate code, traditional token, reconciliation, tag, or GitHub Release
mutation occurred.

`SIGINT` and `SIGTERM` are managed stops, not synchronous exits. Handlers are
installed before publisher child or temporary state exists. During the
irreversible npm window the original signal is forwarded to the npm process
group; a bounded grace period is followed by group `SIGKILL` only when the
group still has a member. Leader close is recorded separately and never counts
as group settlement: the publisher probes the retained detached process-group
identity through the grace and escalation boundaries, including when an
ignoring descendant outlives a cooperative or already-exited leader.

Every registry observation before, during, and after publication is bounded
and registered with the interruption lifecycle. A signal aborts/races any
ordinary in-flight observation so it cannot hold the finalizer open. The
publisher then starts fresh bounded read-only public-registry attempts for both
named packages and records
each as exact `matching`, `absent`, `mismatching`, or `unknown`, re-observes the
line and durable `V` locator, removes all temporary pack/config/home/cache
state, and writes normal schema-2 evidence. Interruption evidence always marks
restart as required so a later dispatch re-observes npm and converges through
registry read-back. Only after evidence and cleanup does the CLI restore the
original signal exit semantics.

When the release-line advertisement changes during publication, finalization
retains the exact observed SHA, fetches that object with the same closed,
no-tags Git boundary, and only then classifies its relationship to `M` and `V`.
A fetch or ancestry failure preserves the observed SHA with relation `unknown`,
a fixed sanitized code, and a restart-required release-state observation.

The accepted issue #14 state contract requires publication to complete before
normal reconciliation or conflict recovery begins. Consequently this slice
never reconciles the release line while either package is absent and never
creates `v1.0.1`, a GitHub Release, or a `1.0.2` proposal.

The issue #19 public-package finalizer is intentionally not installed by this
offline integration. The maintainer validates the open `1.0.1` proposal, exact
`M`, exact deterministic `V`, and the exact draft `1.0.2` proposal, then yields
without publication, reconciliation, tag, Release, or Storybook writes. H/J
remain fail-closed pending a concrete committed finalizer observer/schema. The
draft maintainer does not execute pull-request-head code.
