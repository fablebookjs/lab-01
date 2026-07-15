# Release process

## Current proof slice

This repository currently demonstrates only the first visible release intent:

1. `main`, `releases/v1.0`, and tag `v1.0.0` identify the synthetic `1.0.0`
   baseline.
2. `staged/v1.0` adds one empty commit whose structured trailers identify
   `releases/v1.0`, proposed version `1.0.1`, and the full source commit SHA.
3. A draft PR from `staged/v1.0` to `releases/v1.0` presents that intent for
   review. The commit trailers, parent, and unchanged tree are authoritative;
   the editable PR title and body are not.

In the future contract, merging the current validated release PR is explicit
authorization to publish its exact source. **Do not merge today's PR:** no
publication or reconciliation automation exists in this slice.

## Not yet automated

The following lifecycle stages are intentionally **NOT YET AUTOMATED**:

- marking the proposal ready and starting release QA;
- refreshing the same PR after the release line advances;
- replacing a closed, unmerged proposal;
- materializing and testing exact `1.0.1` packages with isolated Verdaccio;
- publishing packages, reconciling branches, tagging `v1.0.1`, or creating a
  GitHub Release.

Those stages are follow-on work. This slice does not publish to npm, create a
`v1.0.1` tag or GitHub Release, dispatch workflows, or mutate any Storybook
resource.
