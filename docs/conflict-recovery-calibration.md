# Fixed-ref conflict recovery calibration

The manual **Calibrate conflict recovery** workflow uses only the exact
`calibration/g1/conflict-recovery/*` namespace. It builds deterministic `M`, `V`,
and complete late-work head `H` commits, proves `V` and `H` conflict at one fixed
path, and retains immutable graph and backup refs.

`inject-after-force` requires local `HEAD`, remote `main`, and the fixed source to
remain the same trusted-main SHA, then atomically asserts `backup = H` while moving
`line` from `H` to `V` with exact leases. It records the observed post-state,
including abnormal backup drift, and intentionally fails before any PR operation.
`resume` accepts only the exact backup and a line at `H` or `V`, performs the
guarded atomic force only when needed, and creates or reuses one same-repository
draft recovery PR from `backup` to `line`.

Before its sole permitted PR POST, resume retains immutable `pr-attempt = V` in
the same namespace. Once that marker exists, reruns are query-only until the
all-state, fully paginated PR history exposes the canonical draft. Closed,
merged, or duplicate matching history fails closed instead of creating another
proposal.

The retained draft documents the excluded late SHA, @ndelangen as the resolvable
lab author, the need for another patch after the missed `1.0.1`, and the required
conflict resolution. The workflow does not merge that PR, publish packages,
create tags or GitHub Releases, or address the live release PR and refs.
