# Fixed-ref reconciliation calibration

The manual **Calibrate clean reconciliation** workflow exercises three synthetic
Git graphs without using the real `releases/v1.0` or `staged/v1.0` refs:

- `no-late`: a calibration line at sealed merge `M` advances to version snapshot `V`;
- `clean-late`: an advanced head `H` normally reconciles to `J`, whose ordered
  parents are `[H, V]` and whose tree contains both changes; and
- `concurrent-head`: a second late head `H2` wins after reconciliation is
  calculated, so the stale expected-`H` write is rejected and the line remains
  exactly at `H2`.

Every remote write is restricted to
`calibration/g1/reconciliation/<scenario>/*` and uses an explicit
`--force-with-lease` expectation, including expected-absent ref creation.
Fixed graph refs are immutable. Repeated dispatches verify and reuse the retained
result.

This is authority and graph evidence only. It does not publish packages, tag a
release, create a GitHub Release, exercise conflict recovery, or mutate the live
release PR lifecycle.
