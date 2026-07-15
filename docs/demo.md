# Five-minute release-state demo

## 60-second summary

The outcome is a visible, fail-closed release-state contract proven against a
disposable GitHub repository. Start with the public
[release-state explorer](https://fablebookjs.github.io/release-state-explorer/),
then show that the same draft proposal is refreshed, required checks bind to the
current head, conflict recovery retains late work, and an open recovery blocks
the next proposal until a normal merge authorizes exactly one active draft.

The explorer and package names are simulated laboratory material. The linked
GitHub refs, pull requests, checks, workflow runs, lease failures, and recovery
graphs are live retained evidence in `fablebookjs/lab-01`.

## Five-minute click order

### 0:00 — Orient with the state explorer

Open the [release-state explorer](https://fablebookjs.github.io/release-state-explorer/).
Use it to name the states—draft, current-head validation, reconciliation,
recovery, and next proposal. This is an interactive visualization of the policy,
not the production controller.

### 0:40 — Keep one visible draft fresh

Open live [release PR #12](https://github.com/fablebookjs/lab-01/pull/12).
Its empty structured proposal commit makes intent visible while the guarded
staged ref can refresh the same draft instead of creating PR churn. The
[authority baseline](https://github.com/fablebookjs/infra/blob/main/docs/evidence/lab-01-github-authority-baseline.md)
records the live same-draft refresh and close/regenerate mechanics.

### 1:20 — Prove checks follow the current head

Open [required-check PR #23](https://github.com/fablebookjs/lab-01/pull/23).
Show [A succeeding in run 29449854427](https://github.com/fablebookjs/lab-01/actions/runs/29449854427),
then explain that moving A to B left the old green result stale and the PR
blocked. [B succeeds in run 29449963241](https://github.com/fablebookjs/lab-01/actions/runs/29449963241)
only after exact current-head authorization. The complete read-back is in the
[required-check evidence document](https://github.com/fablebookjs/infra/blob/main/docs/evidence/lab-01-required-check-calibration.md).

### 2:20 — Preserve late work through a genuine conflict

Open conflict recovery [PR #16](https://github.com/fablebookjs/lab-01/pull/16).
The sequence is visible in three runs:

- [29429579354](https://github.com/fablebookjs/lab-01/actions/runs/29429579354)
  retains the complete late head before the guarded destructive line update;
- [29429674616](https://github.com/fablebookjs/lab-01/actions/runs/29429674616)
  resumes after the intentional interruption and creates the draft recovery PR;
- [29429754785](https://github.com/fablebookjs/lab-01/actions/runs/29429754785)
  reuses the exact retained graph and PR without duplicate writes.

### 3:20 — Suppress the next proposal while recovery is open

Open dedicated recovery [PR #26](https://github.com/fablebookjs/lab-01/pull/26).
While it was open and clean, sweeps
[29454762852](https://github.com/fablebookjs/lab-01/actions/runs/29454762852)
and [29454800587](https://github.com/fablebookjs/lab-01/actions/runs/29454800587)
both returned `blocked-recovery-open`: no proposal ref and no proposal PR.
PR #26 then merged normally with the exact two-parent recovery graph.

### 4:10 — Create once, then reuse

Run [29454848877](https://github.com/fablebookjs/lab-01/actions/runs/29454848877)
created the structured empty next proposal and draft
[PR #27](https://github.com/fablebookjs/lab-01/pull/27). Run
[29454904814](https://github.com/fablebookjs/lab-01/actions/runs/29454904814)
reused the exact proposal SHA, ref, marker, and PR with no duplicate POST. The
[completed recovery-terminal proof](recovery-terminal-calibration.md) carries
the exact parents, trees, trailers, and retained SHAs.

## What this does—and does not—prove

Proven live in the synthetic lab: GitHub token authority, guarded fixed-ref
writes, same-draft maintenance, current-head required checks, conflict backup
and recovery, open-recovery suppression, and next-proposal creation/reuse.

Not implemented or claimed here:

- public package publication;
- integrated `M`/`V` finalization, version tag, or GitHub Release creation;
- Storybook repository or package migration;
- a commitment to multi-major release-line support.

Those boundaries are intentional. Public finalization and publication remain
owned by `fablebookjs/infra#19`.
