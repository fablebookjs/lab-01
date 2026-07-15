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

## Not yet automated

The following lifecycle stages are intentionally **NOT YET AUTOMATED**:

- marking the proposal ready and starting release QA;
- replacing a closed, unmerged proposal;
- materializing and testing exact `1.0.1` packages with isolated Verdaccio;
- publishing packages, reconciling branches, tagging `v1.0.1`, or creating a
  GitHub Release.

Those stages are follow-on work. This slice does not publish to npm, create a
`v1.0.1` tag or GitHub Release, or mutate any Storybook resource. The draft
maintainer does not execute pull-request-head code.
