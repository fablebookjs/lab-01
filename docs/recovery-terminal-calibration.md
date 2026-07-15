# Fixed-namespace recovery-terminal calibration

This experiment proves only recovery completion and next-proposal suppression for
fablebookjs/infra#15. It is deliberately separate from conflict PR #16, every
`release/*`, `releases/*`, `staged/*`, and versioned calibration namespace.

## Fixed namespace and authority

The experiment can write exactly five branch refs:

| Ref | Purpose |
| --- | --- |
| `calibration/g1/recovery-terminal/source` | Exact trusted `main` commit that seals the experiment |
| `calibration/g1/recovery-terminal/line` | Dedicated line; initially `source`, later the operator-created normal recovery merge |
| `calibration/g1/recovery-terminal/recovery` | One deterministic child of `source` containing the fixed recovery change |
| `calibration/g1/recovery-terminal/proposal` | One structured empty child of the recovered line; absent until recovery is proven merged |
| `calibration/g1/recovery-terminal/pr-attempt` | Resumable POST-state marker, initially `recovery` and advanced once to exact `proposal` |

`source`, `line`, and `recovery` are the smallest deterministic recovery graph.
`proposal` is the required output. `pr-attempt` is the one additional state needed
to prove that every later POST attempt uses the same installed proposal identity.
It does not permanently consume retry authority. No other marker is created.

Both workflows are manual, trusted-main-only, share the same non-cancelling
concurrency group, and check out the exact dispatch SHA without persisted checkout
credentials. Setup has only `contents: write`. Sweep has only `contents: write`
and `pull-requests: write`.

## Live operator sequence

1. Merge the installation PR normally and record the resulting exact `main` SHA.
2. Dispatch **Set up recovery-terminal calibration** from `main` once. A safe
   rerun before the recovery merge reuses the exact four setup refs:

   ```sh
   gh workflow run calibrate-recovery-terminal-setup.yml \
     --repo fablebookjs/lab-01 --ref main
   ```
3. As a human operator, create the dedicated recovery PR with normal GitHub
   mechanics. Do not reuse or modify PR #16:

   ```sh
   gh pr create --repo fablebookjs/lab-01 \
     --base calibration/g1/recovery-terminal/line \
     --head calibration/g1/recovery-terminal/recovery \
     --title "Complete dedicated recovery-terminal calibration" \
     --body "Dedicated clean recovery completion for fablebookjs/infra#15; no publication or finalization."
   ```

4. While that PR is open, dispatch **Sweep recovery-terminal calibration** twice.
   Both runs must report `blocked-recovery-open`. They must leave `proposal`
   absent and must not create a proposal PR:

   ```sh
   gh workflow run calibrate-recovery-terminal-sweep.yml \
     --repo fablebookjs/lab-01 --ref main
   gh workflow run calibrate-recovery-terminal-sweep.yml \
     --repo fablebookjs/lab-01 --ref main
   ```

5. Merge the dedicated recovery PR with GitHub's normal merge-commit method. Do
   not squash or rebase it. The merge must have exact ordered parents
   `[source, recovery]`, the exact recovery tree, equal the PR's
   `merge_commit_sha`, and become the current fixed `line`:

   ```sh
   gh pr merge <recovery-pr-number> --repo fablebookjs/lab-01 --merge
   ```

6. Dispatch the sweep once. It creates or recovers exactly one structured empty
   `proposal` commit and exactly one draft PR from `proposal` to `line`:

   ```sh
   gh workflow run calibrate-recovery-terminal-sweep.yml \
     --repo fablebookjs/lab-01 --ref main
   ```

7. Dispatch the sweep again. With the canonical PR visible, it must reuse the
   same proposal SHA and PR with no ref write or POST. Editable proposal
   title/body changes do not change the authoritative ref, commit, or PR identity:

   ```sh
   gh workflow run calibrate-recovery-terminal-sweep.yml \
     --repo fablebookjs/lab-01 --ref main
   ```

The sweep reads fully paginated, all-state PR history for exact same-repository
base/head identities. Absent, open, or closed-unmerged recovery suppresses before
the proposal is computed or written. Duplicate history, stale line state, wrong
repository identity, non-normal merge topology, or contradictory API state fails
closed.

Every authoritative PR object has an exact state tuple:

| PR state | `state` | `merged` | `draft` | `merged_at` | `merge_commit_sha` | Exact base/head SHAs |
| --- | --- | --- | --- | --- | --- | --- |
| Open recovery | `open` | `false` | `false` | `null` | `null` or full synthetic SHA | `source` / `recovery` |
| Closed-unmerged recovery | `closed` | `false` | `false` | `null` | `null` | `source` / `recovery` |
| Merged recovery | `closed` | `true` | `false` | non-empty string | current `line` | `source` / `recovery` |
| Open proposal | `open` | `false` | `true` | `null` | `null` or full synthetic SHA | recovered `line` / `proposal` |
| Closed-unmerged proposal | `closed` | `false` | `true` | `null` | `null` | recovered `line` / `proposal` |

Missing, null, stringly typed, or contradictory state fields fail closed. A
merged recovery additionally requires current `line = merge_commit_sha`, exact
ordered `[source, recovery]` parents, and the exact recovery tree. A proposal PR
may be open or closed-unmerged, but a merged proposal always fails closed.

These shapes follow read-only live REST evidence from normally merged lab PRs
#17, #18, #20, and #22, mergeable open PRs #19, #21, and #23, and conflicting
open PR #16. GitHub retains the pre-merge base SHA on a merged PR. Mergeable
open PRs can expose a synthetic merge SHA while a conflicting open PR can expose
`null`. A nullable synthetic SHA is retained as evidence only; it never
authorizes or identifies the fixed line.

## Resumable proposal POST protocol

The settled close/regenerate product rule treats closing an unmerged proposal as
an explicit request for replacement. The invariant is therefore one active open
exact proposal PR, not one historical PR number forever. Complete history may
retain any number of exact closed-unmerged attempts, and the stable proposal ref
and commit SHA are reused across every replacement.

The repository has already proven GitHub's uniqueness rule for an active open
same-repository PR with one exact base/head pair: a second create request is
refused as already existing rather than creating a simultaneous second open PR.
This calibration relies only on that active-open uniqueness behavior.

Each sweep queries complete all-state exact history before POSTing. An existing
exact open draft is reused with no POST. Every closed-unmerged exact attempt is
validated and retained as evidence. Any merged proposal, two simultaneous open
proposals, a repeated history record, or wrong identity fails closed. If history
contains no open proposal, the run installs or reuses the exact proposal ref and
`pr-attempt = proposal`, then makes at most one replacement POST. It queries and
polls complete exact history again after every outcome:

- a successful response must converge on that same returned PR identity;
- a definite client rejection records no creation, fails the run if history is
  empty, and leaves the exact state retryable by a later sweep;
- an already-exists/duplicate refusal requeries and converges only on the single
  exact visible PR;
- a network, timeout, rate-limit, malformed response, or 5xx outcome is
  ambiguous and converges only if the single exact PR becomes visible;
- delayed visibility is polled within a fixed bound; persistent invisibility
  fails that run but never strands the namespace, so a corrected later sweep may
  make one exact POST attempt again.

Thus a lost successful response can be followed by a later duplicate refusal
and then converge when the active server-side PR becomes visible. If that hidden
PR instead closes before the next run, one later replacement is correct: the
closed attempt stays in history and exactly one new open proposal becomes
active. Repeated external closes can intentionally create one replacement per
later sweep, never more than one POST per run and never two simultaneous open
exact proposals.

## Explicit boundary

The script has no tag, GitHub Release, npm, release-ref, staged-ref, QA dispatch,
or finalization operation. It preserves PRs #12, #16, #19, #21, and #23, all
existing calibration evidence and protections, `v1.0.0`, zero GitHub Releases,
and the absence of npm `1.0.1`. It never accesses Storybook.

Integrated release finalization, tags, GitHub Releases, and public publication
remain exclusively owned by fablebookjs/infra#19.
