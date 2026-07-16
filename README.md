# Fablebook `lab-01`

`lab-01` is a disposable, synthetic monorepo for proving a visible release-PR
contract without touching Storybook resources. The bounded G1 proof uses only
the two public synthetic packages named below. Public-package finalization is
a separately gated issue #19 concern; the release-PR maintainer never publishes.

The `1.0.0` baseline contains:

- `@fablebook/lab-01-core`;
- `@fablebook/lab-01-addon`, with an exact dependency on core `1.0.0`; and
- an isolated consumer manifest pinned to both packages at `1.0.0`.

Install and run the baseline tests with:

```sh
npm install
npm test
```

The draft release PR proposes `1.0.1` from a structured empty commit on
`staged/v1.0`. Its base is `releases/v1.0`, which started at the same commit as
`main` and tag `v1.0.0`. The previously installed release-line automation
demonstrated refreshing that same PR and regenerating a closed proposal. Its first live transition
closed PR #1 and created [draft PR #12](https://github.com/fablebookjs/lab-01/pull/12);
rerunning the same delivery recognized the existing replacement without
creating another PR. The trusted-main replacement was installed by PR #29 and
its unrelated-close correction by PR #30; a current staged lifecycle run is
still required after this release source is installed.

The installed default-main controller and this release-line candidate give the
maintainer an explicit ownership handoff for
the issue #19 finalizer. With no open proposal, it accepts only the uniquely
latest merged `staged/v1.0` lifecycle PR, its exact ordered merge `M`, the
concrete deterministic `V` snapshot, one exact late `H`, or deterministic
normal reconciliation `J`. H/J are derived by the imported finalizer observer
from stable Git facts and then reclassified in two complete ownership
snapshots; caller-authored markers are not authority. The maintainer performs
no ref, PR-body, or QA dispatch write in those states. It also recognizes one
exact draft `1.0.2` intent without applying its fixed `1.0.1` behavior. The
trusted-main signal/controller maintainer, finalizer workflow, and H/J handoff
are installed on default `main`; none has yet completed the real release path.

See [the release-process note](docs/release-process.md) for the current contract
and explicit automation limits.

Ready-state package QA is implemented as a read-only exact-snapshot check. It
materializes `1.0.1` only in a temporary worktree, publishes only the two
synthetic candidates to loopback Verdaccio, installs them into a temporary
non-workspace consumer, records sanitized identity and integrity evidence, and
then removes the worktree, registry process, and registry storage. It does not
publish to public npm or mutate GitHub state.

The checked-in release/PR-side workflow is only a read-only, no-checkout signal.
The write-capable maintainer and read-only authoritative QA controllers are
discovered on default `main`, check out exact current-main controller code, and
treat signal fields only as wake-ups. The QA controller fetches staged/source
objects as inert data and rederives the one current ready PR and all current
refs from durable state. A
manual dispatch supplies no SHA authority. Local proofs must instead pass
`--authority local`; their evidence is explicitly non-GitHub-current. The prior
installed architecture produced the first GitHub-current proof,
[run 29413168684](https://github.com/fablebookjs/lab-01/actions/runs/29413168684).
It is historical evidence only: no successful current staged run of the new
signal/controller split is claimed. Its controller always retains sanitized evidence named for the
durably rederived staged SHA.

The pinned Verdaccio toolchain is bootstrapped separately from the candidate.
Candidate, publish, and consumer npm subprocesses receive closed environments,
isolated home/config/cache paths, and both default and `@fablebook` registries
pinned to the generated loopback origin. Candidate installation omits the
development-only QA toolchain and cannot use public npm.

The issue #19 publication preparation adds two deliberately separate
public-release surfaces. `Prepare release snapshot` runs from exact current
default `main` and may create only the deterministic
`release-snapshots/v1.0.1` locator after
validating the unique latest merged release intent `M`, the latest successful
exact-head ready-QA authorization, and a fresh isolated regeneration. The run
ID is not part of `V`, so equivalent current QA runs converge. `Publish npm
package` is the one stable OIDC publisher identity. It also runs only exact
current-main code, treats `V` as inert Git data, independently reconstructs the
allowed tree from `M`, and can publish or reuse only `core` first and then
`addon`. The npm trusted-publisher workflow filename remains exactly
`.github/workflows/publish-npm.yml`. It cannot execute candidate code, move the release line, tag, create a
GitHub Release, or create the next proposal. Late descendants of `M` do not
block incomplete package publication. A third installed but unexecuted
finalizer controller handles later reconciliation, tag, GitHub Release, and
next-proposal actions.

The issue #19 controllers are installed on default `main`, and this branch is
their accepted release-line source candidate. The manual operator-only exact
`1.0.0` bootstrap completed on 2026-07-16; both public package tarballs match
the immutable tagged baseline, and an external consumer installed them
together successfully. The `npm-publish` environment exists with no secrets or
reviewers and permits only `main`. Current staged QA is successful; configuring
the exact trusted publisher on both npm package pages is complete. Each package
allows only `npm publish` from `fablebookjs/lab-01` workflow `publish-npm.yml`
and environment `npm-publish`, and requires 2FA while disallowing traditional
tokens. No `1.0.1` snapshot, publication, reconciliation, tag, GitHub Release,
or next proposal is claimed.
