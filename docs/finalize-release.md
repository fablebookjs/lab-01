# `1.0.1` normal-path finalizer

This document is the focused operator contract for the bounded issue #19
finalizer. It is offline implementation guidance only; it does not claim a live
release, npm write, tag, GitHub Release, or GitHub workflow run.

## Installation prerequisite

The separately reviewed maintainer-handoff commit `576da5f` must be integrated
before this workflow is installed or dispatched. The finalizer intentionally
does not modify `scripts/maintain-release-draft.mjs`. The handoff prevents the
draft maintainer from rewriting a post-merge line as another `1.0.1` proposal
and recognizes the finalizer-owned `1.0.2` draft.

The concrete handoff seam is the pure exported function
`observeMaintainerPostMerge({ gitAdapter, releaseHeadSha, mergeSha,
snapshotSha })`. Its adapter must provide `acceptedSnapshot(sha)`,
`commit(sha)`, `isAncestor(ancestor, descendant)`, and
`mergeTree(first, second)`. The function reads real Git objects and validates
the accepted V authority, H/M ancestry, J's exact `[H,V]` parents, merge tree,
and structured reconciliation message before returning either marker:

```text
late-head:
  observer, schemaVersion, line, version, kind,
  mergeSha, verifiedMergeSha, snapshotSha, headSha

normal-reconciliation:
  observer, schemaVersion, line, version, kind,
  mergeSha, snapshotSha, headSha, lateHeadSha, expectedTreeSha,
  metadata: { schemaVersion, line, version, mergeSha, snapshotSha, lateHeadSha }
```

`observer` is exactly `issue-19-finalizer`, `schemaVersion` is `1`, `line` is
`releases/v1.0`, and `version` is `1.0.1`. Callers must not manufacture this
marker from ancestry guesses or user input.

Dispatch `.github/workflows/finalize-release.yml` only from the exact current
default `main`. The workflow has no SHA inputs. Its only input is the fixed
fault choice `none` or `after-github-release-post`.

## One-action loop

Every dispatch freshly reads all Git refs, complete paginated pull-request and
GitHub Release history, and both public npm package versions. It derives the
accepted `S`, `I`, `M`, `V`, QA run, and package hashes from
`release-snapshots/v1.0.1`. It then performs at most one durable action and
reads all durable state again.

The current e51f77c snapshot trailer reader is isolated inside
`LiveGitAdapter.acceptedSnapshot(sha)`. The controller consumes only its
normalized schema-1 authority record (`S/I/M/V`, fixed package hashes, and a QA
authority label). This is the deliberate rebase seam for the corrected OIDC
snapshot contract; no classifier or action relies directly on the old QA-run
trailer identity.

Run the workflow repeatedly until it reports `complete`,
`maintain-next-proposal`, or an intentional wait:

1. Absent or canonically partial npm state is a successful no-op. Publication
   remains owned by the separate tokenless OIDC workflow.
2. With both packages exact, `M` fast-forwards to `V`, or the one clean late
   commit `X/H` becomes deterministic normal merge `J` with parents `[H,V]`.
3. The lightweight `v1.0.1` tag is created at `V` with an expected-absent
   lease.
4. One exact non-draft, non-prerelease GitHub Release is created for that tag.
5. If late `X` exists and no recovery PR is open, `staged/v1.0` advances from
   the sealed `1.0.1` intent to one structured empty `1.0.2` intent.
6. A later dispatch creates or reuses one draft `staged/v1.0` to
   `releases/v1.0` proposal listing the ordered remaining commits.

Blocked or out-of-order state is reported without a write. An incompatible
package, tag, Release, graph, ref, PR identity, or partial state fails closed.

## npm integrity boundary

The finalizer has no npm permission, credential, configuration, or write path.
For each package it independently reads exact-version metadata and downloads
the registry tarball bytes. SHA-512, SHA-1, repository URL, monorepo directory,
and the add-on's sole exact core dependency must all equal `V`.

Only these npm shapes are recognized:

- both absent: wait;
- exact core present and add-on absent: canonical partial, wait;
- both exact: reconciliation may proceed.

The inverse partial, metadata mismatch, downloaded-byte mismatch, or any other
incomplete identity is a permanent stop.

## Reconciliation and recovery boundary

Normal late work is exactly one first-parent commit `X/H` over `M`. `X` must
not be reachable from `V`; `git merge-tree H V` must be clean. `J` has the exact
merge tree, ordered parents `[H,V]`, and fixed metadata. A stale release-line
lease is rejected and the complete state is re-read on the next invocation.

A real conflict is not repaired here. The finalizer stops and points to the
retained issue #15 recovery proof. A valid recorded recovery branch and draft
PR may coexist with the tag and GitHub Release; an open exact recovery PR
suppresses the `1.0.2` proposal. Calibration refs and PRs are unrelated because
all matching uses only the exact production-lab branch identities.

## Lost-success proof

Choose `after-github-release-post` only for the retained lost-response
demonstration. The fault fires after the POST has succeeded and the exact
Release is durably visible, but before a success report. The next dispatch
reuses that Release and never posts a duplicate.

## Evidence and inspection

Each run uploads one sanitized JSON document containing actor, event, fixed
permissions, trusted source, release PR, `S/I/M/V`, QA run, npm identities,
`H/X/J`, old/new action refs, tag, Release ID/URL, recovery, next intent/PR, and
before/after preservation fingerprints. It records no token, npm config,
temporary path, or raw command diagnostic.

Useful read-only checks after convergence:

```text
git show --no-patch --format='%H %P %T%n%B' refs/tags/v1.0.1
git show --no-patch --format='%H %P %T%n%B' origin/releases/v1.0
git merge-base --is-ancestor <X> refs/tags/v1.0.1   # must be false
git merge-base --is-ancestor <X> origin/releases/v1.0 # must be true after J
```

No instruction in this document authorizes a Storybook mutation.
