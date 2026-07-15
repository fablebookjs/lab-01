# Fixed-namespace recovery-terminal calibration

**Status: completed live proof.** This experiment proved recovery completion and
next-proposal suppression for fablebookjs/infra#15. It is deliberately separate
from conflict PR #16, every `release/*`, `releases/*`, `staged/*`, and versioned
calibration namespace.

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

## Completed live proof

The controller was installed through normal [lab PR #25](https://github.com/fablebookjs/lab-01/pull/25),
producing trusted `main` commit
[`e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37`](https://github.com/fablebookjs/lab-01/commit/e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37).

| Phase | Retained live evidence | Exact result |
| --- | --- | --- |
| Setup | [run 29454697392](https://github.com/fablebookjs/lab-01/actions/runs/29454697392) | `source = line = e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37`; `recovery = pr-attempt = 019d79a611ee6c89a19e5369ddfb79ebd14efc62`; `proposal` absent |
| Dedicated recovery opened | [PR #26](https://github.com/fablebookjs/lab-01/pull/26) | Clean same-repository PR from `recovery@019d79a611ee6c89a19e5369ddfb79ebd14efc62` to `line@e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37` |
| Open suppression 1 | [run 29454762852](https://github.com/fablebookjs/lab-01/actions/runs/29454762852) | `blocked-recovery-open`; proposal ref and proposal PR absent; fixed refs unchanged |
| Open suppression 2 | [run 29454800587](https://github.com/fablebookjs/lab-01/actions/runs/29454800587) | `blocked-recovery-open`; proposal ref and proposal PR absent; fixed refs unchanged |
| Normal recovery merge | [PR #26](https://github.com/fablebookjs/lab-01/pull/26) | `J = 77a46f4ddf7eedb097e8447b335f6c791472d15e`, ordered parents `[e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37, 019d79a611ee6c89a19e5369ddfb79ebd14efc62]`, tree `0f8fa5f3455e7905e4987603477e657291833b64` |
| Proposal creation | [run 29454848877](https://github.com/fablebookjs/lab-01/actions/runs/29454848877), [draft PR #27](https://github.com/fablebookjs/lab-01/pull/27) | `proposal = pr-attempt = b1a266b6c5b1424b336bc102b9876f2912e5c0d3`; outcome `proposal-created` |
| Proposal reuse | [run 29454904814](https://github.com/fablebookjs/lab-01/actions/runs/29454904814) | Outcome `proposal-reused`; exact proposal ref, marker, SHA, and PR #27 unchanged |

The [proposal commit](https://github.com/fablebookjs/lab-01/commit/b1a266b6c5b1424b336bc102b9876f2912e5c0d3)
has the single parent `J`, the same tree
`0f8fa5f3455e7905e4987603477e657291833b64`, and these exact trailers:

```text
Proposal-Base: calibration/g1/recovery-terminal/line
Proposal-Version: 1.0.2
Recovered-Line: 77a46f4ddf7eedb097e8447b335f6c791472d15e
Recovery-Head: 019d79a611ee6c89a19e5369ddfb79ebd14efc62
```

The [comparison from `J` to the proposal](https://github.com/fablebookjs/lab-01/compare/77a46f4ddf7eedb097e8447b335f6c791472d15e...b1a266b6c5b1424b336bc102b9876f2912e5c0d3)
is exactly one commit and zero changed files.

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
| Closed-unmerged proposal | `closed` | `false` | `true` | `null` | `null` or full synthetic SHA | recovered `line` / `proposal` |

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

Read-only closed-unmerged proposal PR #1 also retains a full synthetic
`merge_commit_sha`. Closed proposal history therefore accepts either `null` or
one lowercase full SHA and records that value only as non-authoritative evidence;
the recovered line, proposal ref, and proposal commit remain the sole identities.

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

The completed live read-back confirmed those preservation claims: the prior
release and calibration PRs/refs remained intact, `v1.0.0` remained the only
tag, GitHub Releases remained empty, npm `1.0.1` remained unpublished, and no
Storybook resource was touched. There is no pending proof in this calibration.

Integrated release finalization, tags, GitHub Releases, and public publication
remain exclusively owned by fablebookjs/infra#19.
