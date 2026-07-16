# `1.0.1` normal-path finalizer

This is the focused operator contract for the bounded issue #19 finalizer. It
describes offline implementation and proof only; it does not claim a live npm
write, tag, GitHub Release, workflow run, or Storybook change.

In the combined offline state, the manual exact `1.0.0` bootstrap exists but
has not published; the trusted-main `V` preparation and direct-OIDC publisher
exist but are not installed or live; and this finalizer plus its maintainer H/J
handoff are likewise local-only. Public package and finalization state remain
unchanged.

## Installation prerequisite and maintainer seam

This offline branch integrates the separately reviewed maintainer handoff with
the finalizer observer. Neither the finalizer workflow nor the H/J handoff is
installed or live, and this document does not authorize dispatch.

The handoff imports and calls the pure exported seam:

```text
observeMaintainerPostMerge({
  gitAdapter,
  releaseHeadSha?, // expectation only
  mergeSha?,       // expectation only
  snapshotSha?,    // expectation only
})
```

The adapter provides `listRefs()`, `acceptedSnapshot(sha)`, `commit(sha)`,
`isAncestor(ancestor, descendant)`, and `mergeTree(first, second)`. The observer
itself reads complete stable Git advertisements, derives current
`releases/v1.0`, derives V from current `release-snapshots/v1.0.1`, derives M
through the accepted V adapter, validates real objects/ancestry/tree/structured
metadata, and rechecks all advertised refs before returning. Optional caller
SHAs never select H, J, M, or V.

```text
late-head:
  observer, schemaVersion, line, version, kind,
  mergeSha, verifiedMergeSha, snapshotSha, headSha

normal-reconciliation:
  observer, schemaVersion, line, version, kind,
  mergeSha, snapshotSha, headSha, lateHeadSha, expectedTreeSha,
  metadata: { schemaVersion, line, version, mergeSha, snapshotSha, lateHeadSha }
```

`observer` is `issue-19-finalizer`, schema is `1`, line is `releases/v1.0`, and
version is `1.0.1`. A self-attested marker or arbitrary ancestry guess is not
authority.

## Trusted dispatch and one-action loop

Dispatch `.github/workflows/finalize-release.yml` only from exact current
default `main`. The workflow has no SHA inputs. Its only input is the fixed
fault choice `none` or `after-github-release-post`.

Every dispatch reads stable complete Git advertisements, two identical bounded
sweeps of fully hydrated pull-request and GitHub Release history, and both
public npm package versions. It derives accepted `S`, `I`, `M`, `V`, QA
authority, and package hashes from `release-snapshots/v1.0.1`, classifies one
controller action, and exactly rereads durable state.

Immediately before every Git push and GitHub POST, the controller rebinds
remote `main`, local `HEAD`, `GITHUB_SHA`, and `GITHUB_WORKFLOW_SHA`. Workflow
identity must be exactly
`fablebookjs/lab-01/.github/workflows/finalize-release.yml@refs/heads/main`.
After a POST marker is spent, one final stable read also binds the release
line/base, staged/head, V locator, lightweight tag, recovery ref, and both
attempt refs to the classified plan. The POST adapter carries exact head/base
or line/tag/V expectations in evidence, immediately hydrates the created
object, and requires GitHub to have stored those exact identities. Pre-POST
drift is query-only.

These checks minimize but cannot make Git and GitHub one atomic CAS: a ref can
move after the final Git advertisement and before GitHub accepts the request.
Immediate object hydration detects that irreducible cross-service race but
cannot undo an object GitHub already created. The run fails with the spent
authorization and exact before/after evidence; reruns remain query-only.

The snapshot parser is isolated inside `LiveGitAdapter.acceptedSnapshot(sha)`.
It consumes schema-2 snapshot authority: Release-Snapshot-Version,
Release-Line/Version/Merge, Release-QA-Staged/QA-Source, Release-Tree,
Release-Content-SHA256, and both packages' integrity/shasum. There is no
Release-QA-Run identity. It delegates to the shared trusted-main validator in
`release-publication.mjs`, which derives S/I/M from the concrete graph,
reconstructs the only permitted four-file transform, requires exact whole-tree
equality, four `M` name-status changes and `100644` blobs, validates complete
root/package/workspace-lock shapes and exact inert package contents, reads Git
blobs as raw buffers, and deterministically repacks both packages with the
closed fixed npm CLI. Only after those independent facts exist does it parse
and cross-check V's tree/content/package trailers. No classifier parses
snapshot trailers directly.

Repeated dispatches converge in this order:

1. Absent or canonical core-only npm publication waits successfully.
2. With both packages exact, M fast-forwards to V, or one clean late H becomes
   deterministic normal J with parents `[H,V]`.
3. A lightweight `v1.0.1` tag is leased from absent to V.
4. One exact non-draft, non-prerelease GitHub Release is created through the
   durable attempt protocol below.
5. With remaining late work and no open recovery PR, sealed staged intent is
   leased to one structured empty `1.0.2` intent over current J/V.
6. A later dispatch creates or reuses one draft `staged/v1.0` to
   `releases/v1.0` proposal over the current line SHA.

Hydrated production-branch PR history is partitioned by each head commit's
exact structured intent version and source. Valid closed-unmerged `1.0.1`
lifecycle attempts, including retained PR #1-shaped history, remain preserved
and do not enter `1.0.2` cardinality. Their editable title/body are presentation,
not authority. Exact next-version rules apply only to the current `1.0.2`
lineage, where the current proposal's settled title/body are checked separately;
malformed or wrong structured same-version identities stop.

Blocked or out-of-order state is a successful no-op. Contradictory package,
graph, ref, tag, Release, recovery, or PR identity fails closed.

## npm integrity boundary

The finalizer has no npm permission, credential, configuration, or write path.
For both fixed packages it independently reads exact-version metadata and
downloads public-registry tarball bytes. Metadata and downloaded SHA-512/SHA-1,
repository URL/directory, and the add-on's exact core dependency must all match
V.

Recognized states are both absent, exact core with absent add-on, or both exact.
The inverse partial, byte mismatch, metadata mismatch, or any other incomplete
identity permanently stops before reconciliation.

## Reconciliation and recovery

Normal late work is one first-parent commit H over M. H must be absent from V;
`git merge-tree H V` must be clean. Normal J has that exact tree, ordered
parents `[H,V]`, and deterministic structured metadata. Every push has an exact
old-to-new lease; stale rejection refetches complete state.

A real conflict is never repaired here. The finalizer points to the retained
issue #15 proof. Recorded recovery is exact `recovery/v1.0/1.0.1 = H`, where H
is the sole late commit over M and H/V genuinely conflicts. Its open tuple is an
exact draft PR from H to current V with the line at V. Its merged tuple is an
exact non-draft, merged PR whose merge commit is current J with parents `[V,H]`.
J may have a human conflict-resolution tree and need not match a clean
`merge-tree`. Closed-unmerged, duplicate, malformed, or unbound recovery state
fails closed. Open recovery suppresses `1.0.2`; exact merged recovery may later
source it. Exact calibration identities remain unrelated.

## Closed mutation and transport boundary

Every ref update uses `--no-follow-tags`. Only the release line, staged line,
lightweight tag, and two fixed attempt refs are writable. The Git adapter builds
a closed environment and allowlists every effective local setting. Generic or
URL-scoped proxy/TLS/CA/certificate/low-speed settings, credentials, includes,
remote service/proxy commands, URL rewrites, push URLs, tag following, askpass,
and alternates/replacements are rejected before any advertisement, write, or
GitHub API call. Only exact origin/fetch mechanics, inert repository mechanics,
branch tracking, and at most checkout's single scoped GitHub authorization
header survive. Exact `LC_ALL=C --porcelain` stale status is separate from auth,
transport, policy, and malformed-output errors; only an exact post-read proves
lost success.

GitHub accepts only exact GET/POST methods and repository endpoints. npm accepts
only exact public-registry metadata and tarball GETs for the fixed packages.
Both HTTP adapters reject inherited proxy/TLS/CA overrides. Tokens, raw command
output, temporary paths, authentication, and configuration never enter evidence
or sanitized errors.

PR and Release collections are routed by their parsed exact endpoint path.
Every PR list item must carry positive integer `number` and `id`; hydration and
POST readback bind both identities to the requested endpoint and reject missing,
string, swapped, or aliased IDs across complete sweeps.

## Durable POST attempts

```text
refs/heads/finalizer-attempts/v1.0.1/github-release
  absent -> M (authorized) -> V (spent before POST)
  V -> I (definite pre-creation rejection) -> M (explicit reauthorization)

refs/heads/finalizer-attempts/v1.0.2/next-proposal
  absent -> current J/V (authorized) -> exact 1.0.2 intent (spent before POST)
  intent -> V (definite pre-creation rejection) -> current J/V (reauthorize)
  intent -> current J/V after exact closed-unmerged PR (regenerate)
```

Every transition has an exact lease. One classified POST action is a bounded
protocol: consume the authorization, stably reread the marker, then issue at
most one POST. The post-marker read binds every mutable planned ref and trusted
main, and the POST response is immediately hydrated by exact returned
number/id, canonical URL/repository, state, and stored SHA tuple. Once spent,
reruns are query-only until two complete stable
history sweeps reveal the object. Ambiguous failures never reauthorize. Only a
definite pre-creation client rejection plus exact all-state absence records the
explicit rejected state. A POST action therefore may contain its marker write
and single POST while never issuing two POSTs per authorization.

The optional fault fires only after the Release POST succeeds and the exact
Release is durably visible, before reporting success. Its rerun follows the same
spent-marker reuse path as an ordinary lost response or delayed visibility.

## Evidence and inspection

Every run uploads sanitized schema-2 JSON containing actor/event/permissions/source,
each pre-mutation main binding, release PR, S/I/M/V, QA authority, npm
identities, H/J, action old/new refs, tag, Release ID/URL, recovery, next
intent/PR, and full before/after canonical tuples for relevant refs, PRs,
Releases, and packages. Instrumentation records exact methods, destinations,
and writes. Immediately after every accepted ref/marker write, exact stable
readback is captured as partial durable evidence. Any later main/ref drift,
transport, hydration, post-read, or injected-fault failure retains those
transitions plus the latest full re-observation when one is available; a known
durable write is never represented as `durableEvidence: null`.

The preservation claim is deliberately scoped: it proves what this finalizer
process asked its exact `fablebookjs/lab-01` Git/GitHub and two read-only npm
adapters to do. Static workflow/code inspection reinforces that there is no
Storybook target, but the run does not observe arbitrary external Storybook
state.

Useful read-only checks after convergence:

```text
git show --no-patch --format='%H %P %T%n%B' refs/tags/v1.0.1
git show --no-patch --format='%H %P %T%n%B' origin/releases/v1.0
git merge-base --is-ancestor <H> refs/tags/v1.0.1       # false
git merge-base --is-ancestor <H> origin/releases/v1.0  # true after J
```

No instruction in this document authorizes a Storybook mutation.
