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

`setup` creates a deterministic `base -> A -> B` graph and initializes `head` to
A. `advance-head` performs the sole mutable transition, guarded A-to-B. Every
creation and transition uses an explicit old-SHA lease, an explicit `SHA:ref`
refspec, and `--no-follow-tags`. Reruns reuse an exact retained state or fail
closed. There is no approval ref or approval write.

Before every Git advertisement or write, both scripts reject inherited Git
environment overrides, isolate global and system configuration, and audit the
repository configuration against a credential-free fixed allowlist. Local
`include`/`includeIf`, HTTP headers, proxy, TLS, CA, certificate, low-speed,
credential-helper, URL-rewrite, upload-pack, receive-pack, and other
transport/authentication overrides fail before network Git runs.

Both workflows check out with `persist-credentials: false`. The write-capable
state step receives only `${{ github.token }}` as `GITHUB_TOKEN`; the script
requires it before any live advertisement or write, removes it from every child
environment, and internally supplies one exact
`http.https://github.com/.extraheader` through controlled `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0` child variables. The token and
encoded header never appear in arguments, output, summaries, or errors. The
read-only check remains credential-free because `fablebookjs/lab-01` is public.

The first live `setup` dispatch was retained as a safe failure:
[run 29437465131](https://github.com/fablebookjs/lab-01/actions/runs/29437465131)
checked out trusted main `d44db671e7f2c70e4ad2dc4b78589af74da77786`
but stopped before creating any required-check ref with
`Unsafe repository Git config:
includeif.gitdir:/home/runner/work/lab-01/lab-01/.git.path`. Checkout v7 had
persisted its credential through that local include. This revision keeps
includes forbidden and instead uses the explicit controlled credential path
above. No successful rerun is claimed here.

The separate **Required check calibration** workflow has only `contents: read`,
one stable job named **Required calibration head**, and can dispatch only on the
fixed `head` branch. Every dispatch requires one full `authorized_sha` input. It
succeeds only when `GITHUB_SHA`, checked-out `HEAD`, the current remote `head`,
and `authorized_sha` are the same exact commit.

The explicit workflow dispatch is the authorization and wake-up for this
experiment. This slice proves GitHub's current-head required-check binding; it
does not prove the identity, entitlement, or policy right of the maintainer who
chooses `authorized_sha`.

## Authoritative live evidence contract

Use one stable `PR` number for every phase. Preserve the raw response from every
query below under phase names `a-green`, `b-missing`, `b-failing`, and `b-green`.
Never merge, close, or draft this PR.

The proof intentionally separates two GitHub observations:

- Graph mergeability is GraphQL `mergeable`. It must remain `MERGEABLE`; this
  says only that GitHub can construct the merge.
- Policy authorization is GraphQL `mergeStateStatus`. It must change among
  `CLEAN`, `BLOCKED`, and `UNSTABLE` as the exact required check on the current
  head changes.
  REST check-run and branch-protection responses bind that change to the exact
  SHA, context, and GitHub Actions App.

Use API version `2026-03-10` for all REST reads and writes. Percent-encode the
protected branch when constructing REST endpoints:

```sh
REPO=fablebookjs/lab-01
BASE=calibration/g1/required-check/base
HEAD=calibration/g1/required-check/head
ENCODED_BASE=$(jq -rn --arg value "$BASE" '$value | @uri')
```

For each exact A or B SHA, retain all check runs, then select the most recently
completed run whose name and App match the protected requirement:

```sh
gh api --paginate \
  --slurp \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/commits/$SHA/check-runs?filter=all&per_page=100" \
  > "$PHASE-check-runs.json"

# Bootstrap the exact protected pair from A's successful GitHub Actions run.
A_RUN=$(jq -ce --arg sha "$A" \
  '[.[].check_runs[] |
    select(.head_sha == $sha and
           .name == "Required calibration head" and
           .app.slug == "github-actions" and
           .status == "completed" and
           .conclusion == "success")] |
   sort_by(.id) | last | select(. != null)' \
  a-green-check-runs.json)
CONTEXT=$(jq -r '.name' <<<"$A_RUN")
APP_ID=$(jq -r '.app.id' <<<"$A_RUN")

jq -e --arg sha "$SHA" \
  --arg context "$CONTEXT" \
  --argjson app_id "$APP_ID" \
  '[.[].check_runs[] |
    select(.head_sha == $sha and .name == $context and .app.id == $app_id)] |
   sort_by(.id) | last | select(. != null) |
   {name, head_sha, status, conclusion,
    app: {id: .app.id, slug: .app.slug}, html_url}' \
  "$PHASE-check-runs.json"
```

The selected check-run tuple is
`(name, head_sha, status, conclusion, app.id, app.slug, html_url)`. The name must
be exact `Required calibration head`, `head_sha` must be the phase SHA,
`status` must be `completed`, and `app.slug` must be `github-actions`. Record the
numeric `app.id` from A; configure and read back that same ID rather than
allowing any App.

Read back protection before every policy decision:

```sh
gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/branches/$ENCODED_BASE/protection" \
  > "$PHASE-protection.json"

jq -e \
  --arg context "$CONTEXT" \
  --argjson app_id "$APP_ID" \
  '.required_status_checks.strict == false and
   .enforce_admins.enabled == true and
   (.required_status_checks.checks | length) == 1 and
   .required_status_checks.checks[0].context == $context and
   .required_status_checks.checks[0].app_id == $app_id' \
  "$PHASE-protection.json"
```

The protection tuple must be exact
`(required_status_checks.strict=false, enforce_admins.enabled=true,
required_status_checks.checks=[{context: CONTEXT, app_id: APP_ID}])`. Stop if
there is no rule, an extra required check, a different context or App, strict is
not false, or admins are not enforced.

Poll this GraphQL query every five seconds, for at most five minutes, after each
ref/check transition. Preserve every response. A phase is terminal only when
`headRefOid` is the expected SHA, `mergeable` is not `UNKNOWN`,
`mergeStateStatus` is not `UNKNOWN`, `contexts.totalCount` is at most 100, and
the current commit's exact check context has reached the expected absent or
completed state:

```graphql
query RequiredCheckCalibration($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      state
      isDraft
      merged
      mergedAt
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      mergeable
      mergeStateStatus
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    detailsUrl
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Save the exact query above as `required-check-calibration.graphql`, run it with
the stable PR number, and save the result:

```sh
gh api graphql \
  -f query="$(cat required-check-calibration.graphql)" \
  -f owner=fablebookjs \
  -f name=lab-01 \
  -F number="$PR" \
  > "$PHASE-policy.json"
```

Every terminal response must also have this invariant PR tuple:
`(number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null,
baseRefName=BASE, baseRefOid=BASE_SHA, headRefName=HEAD)`. The one commit returned
by `commits(last:1)` must have `oid=headRefOid`.

The phase-specific acceptance tuples are:

| Phase | PR head / explicit input | Latest exact REST check on current head | GraphQL `(mergeable, mergeStateStatus, statusCheckRollup.state)` |
| --- | --- | --- | --- |
| `a-green` | head A; `authorized_sha=A` | `(A, completed, success, APP_ID, github-actions)` | `(MERGEABLE, CLEAN, SUCCESS)` |
| `b-missing` | head B; no B dispatch | exact context absent on B; A success still present when A is queried | `(MERGEABLE, BLOCKED, null)` |
| `b-failing` | head B; `authorized_sha=A` | `(B, completed, failure, APP_ID, github-actions)` | `(MERGEABLE, UNSTABLE, FAILURE)` |
| `b-green` | head B; `authorized_sha=B` | latest exact B run is `(B, completed, success, APP_ID, github-actions)` | `(MERGEABLE, CLEAN, SUCCESS)` |

Any other tuple, timeout, pagination overflow, more than one protected check,
changed PR number, or non-open/merged/draft PR is a failed calibration—not
evidence to reinterpret.

## Live operator sequence

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
   release PR #12 or conflict-recovery PR #16. Record the new stable PR number,
   `BASE_SHA`, A, and B.

3. Dispatch the read-only check on the calibration head and verify that its run
   SHA is exact A and its sole job succeeds:

   ```sh
   gh workflow run calibrate-required-check.yml \
     --repo fablebookjs/lab-01 \
     --ref calibration/g1/required-check/head \
     -f authorized_sha="$A"
   ```

4. Query exact A's check runs. Set `CONTEXT` from its exact name and `APP_ID` from
   the run's exact `github-actions` App. Through the repository admin API,
   protect only `base` with this exact generated payload (the other false/null
   fields prevent unrelated policy from contaminating the experiment):

   ```sh
   jq -n \
     --arg context "$CONTEXT" \
     --argjson app_id "$APP_ID" \
     '{
       required_status_checks: {
         strict: false,
         contexts: [],
         checks: [{ context: $context, app_id: $app_id }]
       },
       enforce_admins: true,
       required_pull_request_reviews: null,
       restrictions: null,
       required_linear_history: false,
       allow_force_pushes: false,
       allow_deletions: false,
       block_creations: false,
       required_conversation_resolution: false,
       lock_branch: false,
       allow_fork_syncing: false
     }' > a-green-protection-request.json

   gh api --method PUT \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/branches/$ENCODED_BASE/protection" \
     --input a-green-protection-request.json \
     > a-green-protection-response.json
   ```

   Substitute the observed string and numeric App ID, retain the exact PUT
   request/response, and read the protection back. Poll the authoritative query
   until the exact `a-green` tuple is present. Do not infer policy authorization
   from REST `mergeable` or the graph-only GraphQL `mergeable` field.

5. Move only `head` from A to B:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=advance-head
   ```

   Confirm that A's successful check is still retained, the PR now has exact B,
   and exact B has no check run with `CONTEXT` and `APP_ID`. Poll until the exact
   `b-missing` tuple is present. With `strict=false`, this isolates current-head
   check binding from base-update strictness.

6. Dispatch the same read-only check on exact B while explicitly authorizing A:

   ```sh
   gh workflow run calibrate-required-check.yml \
     --repo fablebookjs/lab-01 \
     --ref calibration/g1/required-check/head \
     -f authorized_sha="$A"
   ```

   Its run SHA must be exact B and the same job/context must fail with
   `dispatched-sha-is-not-authorized`. This is the explicit stale-green rejection
   observation: A remains green while B is unauthorized. Poll until the exact
   `b-failing` tuple is present.

7. Dispatch the same check on exact B while explicitly authorizing exact B:

   ```sh
   gh workflow run calibrate-required-check.yml \
     --repo fablebookjs/lab-01 \
     --ref calibration/g1/required-check/head \
     -f authorized_sha="$B"
   ```

   Verify that the latest exact B run makes the same context/App pair green.
   Poll until the exact `b-green` tuple is present. Re-read the protection and
   invariant PR tuples, and verify the PR was never merged.

8. Retain the PR, four refs, workflow runs, check records, and branch-protection
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
