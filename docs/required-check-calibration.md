# Fixed-ref required-check calibration

This calibration is designed to test whether GitHub branch protection binds a
successful required check to the pull request's current head SHA. It does not
claim that behavior has been proved until the complete live sequence below is
observed and retained.

The write-capable **Calibrate required-check state** workflow is manual,
dispatches only from trusted `main`, and owns exactly these refs:

- `calibration/g1/required-check/base`
- `calibration/g1/required-check/a`
- `calibration/g1/required-check/b`
- `calibration/g1/required-check/head`
- `calibration/g1/required-check/approved`

`setup` creates a deterministic `base -> A -> B` graph and initializes both
`head` and `approved` to A. `advance-head` performs only the guarded A-to-B head
transition. `approve-head` is allowed only after `head` is exact B and performs
only the guarded A-to-B approval transition. Every creation and transition uses
an explicit old-SHA lease, an explicit `SHA:ref` refspec, and
`--no-follow-tags`. Reruns reuse an exact retained state or fail closed.

The separate **Required check calibration** workflow has only `contents: read`,
one stable job named **Required calibration head**, and can dispatch only on the
fixed `head` branch. It succeeds only when its checked-out `GITHUB_SHA` equals
both the remote `head` ref and the remote `approved` ref.

## Live operator sequence

Use the exact repository and ref names below. Record each workflow URL, run SHA,
check name/context, PR state, protection response, and mergeability observation.
Wait for GitHub's asynchronous mergeability calculation after every state
change. Never merge the calibration PR.

1. Install this code through the normal repository process. From trusted
   `main`, initialize the retained graph:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=setup
   ```

2. Read the completed setup summary and record exact A and B. Create one normal,
   non-draft PR with base `calibration/g1/required-check/base` and head
   `calibration/g1/required-check/head`. Do not reuse, close, draft, or merge
   release PR #12 or conflict-recovery PR #16.

3. Dispatch the read-only check on the calibration head and verify that its run
   SHA is exact A and its sole job succeeds:

   ```sh
   gh workflow run calibrate-required-check.yml \
     --repo fablebookjs/lab-01 \
     --ref calibration/g1/required-check/head
   ```

4. Observe the exact successful check context reported by GitHub. Through the
   repository admin API, protect only
   `calibration/g1/required-check/base`, require that exact context, set required
   status checks `strict` to `false`, and set `enforce_admins` to `true`. Do not
   guess the context from this document: use the context attached to exact A.
   Retain the request and response, then confirm the PR at A is mergeable under
   that rule without merging it.

5. Move only `head` from A to B:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=advance-head
   ```

   Confirm that A's successful check is still retained, the PR now has exact B,
   `approved` remains exact A, and the PR is not mergeable because B has no
   successful instance of the required context. With `strict: false`, this
   isolates current-head check binding from base-update strictness.

6. Dispatch the same read-only check on `head` again. Its run SHA must be exact B
   and the same job/context must fail with `current-head-is-not-approved`. This
   is the explicit stale-green rejection observation: A remains green while B is
   unauthorized.

7. Move only `approved` from A to B, then rerun the same check on exact B:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=approve-head

   gh workflow run calibrate-required-check.yml \
     --repo fablebookjs/lab-01 \
     --ref calibration/g1/required-check/head
   ```

   Verify that the exact B run now makes the same required context green and
   that GitHub reports the still-unmerged calibration PR mergeable again.

8. Retain the PR, five refs, workflow runs, check records, and branch-protection
   evidence for issue #15. Cleanup or protection removal is a separate,
   explicitly authorized operation.

## Preservation boundary and non-goals

The calibration must not modify `releases/v1.0`, `staged/v1.0`, release PR #12,
conflict-recovery PR #16, any prior calibration ref, any tag or GitHub Release,
package publication state, infra repository policy, or Storybook resources. The
workflows do not create, edit, close, or merge pull requests and do not configure
branch protection. They do not prove production credential suitability, strict
base synchronization, recovery completion, publication, or the wider G1
lifecycle.
