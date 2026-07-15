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

Inject retains immutable `pr-attempt = H` in the same namespace. Immediately
before the sole permitted PR POST, resume consumes that authorization with an
exact leased `H` to `V` marker transition. A marker already at `V` is query-only,
and an absent or incompatible marker is never recreated by resume. If execution
stops after the marker reaches `V` but before the POST, reruns remain safely
blocked pending retained evidence and human calibration cleanup; no extra state
is inferred. The all-state, fully paginated PR history is the only convergence
proof after `V`. Closed, merged, or duplicate matching history fails closed.

The retained draft documents the excluded late SHA, @ndelangen as the resolvable
lab author, the need for another patch after the missed `1.0.1`, and the required
conflict resolution. The workflow does not merge that PR, publish packages,
create tags or GitHub Releases, or address the live release PR and refs.
