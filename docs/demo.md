# Five-minute public patch-release demo

## 60-second summary

`fablebookjs/lab-01` now demonstrates a complete public `1.0.1` patch release:
a reviewed empty release intent, exact Ready QA, deterministic immutable
snapshot `V`, OIDC publication with a deliberate core-only pause, an ordinary
late fix, clean reconciliation, tag and GitHub Release creation, lost-success
recovery, and one draft `1.0.2` proposal carrying the late work.

Start with the public [GitHub Release](https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1),
the npm pages for [core](https://www.npmjs.com/package/@fablebook/lab-01-core/v/1.0.1)
and [add-on](https://www.npmjs.com/package/@fablebook/lab-01-addon/v/1.0.1),
and [draft PR #44](https://github.com/fablebookjs/lab-01/pull/44). The complete
identity and run ledger is in the [issue #19 live evidence](issue-19-live-evidence.md).

## Five-minute click order

### 0:00 — Show the public outcome

Open the [v1.0.1 GitHub Release](https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1).
Its lightweight tag resolves to exact snapshot `V=30fb7cf…`. Open both npm
packages and point out their provenance, repository identity, and exact
`1.0.1` versions.

### 0:50 — Show partial publication and continuation

[Core run 29487214563](https://github.com/fablebookjs/lab-01/actions/runs/29487214563)
published and verified only core, then stopped with add-on absent. An ordinary
late release-line fix landed while that partial state was durable.
[Add-on run 29488397580](https://github.com/fablebookjs/lab-01/actions/runs/29488397580)
reverified core and published only the missing add-on. Neither job had a
traditional npm token or a finalization permission.

### 1:50 — Separate published bytes from late work

Open [reconciliation run 29489041168](https://github.com/fablebookjs/lab-01/actions/runs/29489041168).
`V` contains only the four version-transform files. Late merge `X=bc2c997…` is
not reachable from `V`. The controller created exact `J=5469d7a…` with ordered
parents `[X,V]`, so the release line contains both the late fix and the public
version snapshot without changing what tag `v1.0.1` names.

### 2:50 — Demonstrate lost-success convergence

[Run 29489970777](https://github.com/fablebookjs/lab-01/actions/runs/29489970777)
spent its durable authorization, created and hydrated the one GitHub Release,
then intentionally failed before success reporting. Recovery
[run 29490136244](https://github.com/fablebookjs/lab-01/actions/runs/29490136244)
found that exact Release, issued no duplicate POST, and advanced the structured
`1.0.2` intent.

### 3:50 — Carry the late fix forward

Open [draft PR #44](https://github.com/fablebookjs/lab-01/pull/44). It is a
zero-file empty intent from `staged/v1.0` to `releases/v1.0`, based on exact
`J`, and lists `X` as the work excluded from `1.0.1`. Proposal creation
[run 29490413923](https://github.com/fablebookjs/lab-01/actions/runs/29490413923)
spent one authorization and created one PR; duplicate
[run 29490566032](https://github.com/fablebookjs/lab-01/actions/runs/29490566032)
made zero mutations.

### 4:35 — Connect to the broader release model

Open the public [release-state explorer](https://fablebookjs.github.io/release-state-explorer/)
to name the states and show how conflict recovery differs from this clean live
path. The retained conflict, required-check, and recovery-terminal calibrations
remain linked from the repository README and were not replayed destructively on
the real release line.

## Boundaries

This is a disposable two-package, one-release-line laboratory proof. It does
not mutate Storybook, deploy documentation, implement multi-major branch cuts
or forward ports, or establish production support policy. Those are separate
program increments, not hidden claims of this demo.
