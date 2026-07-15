# Pull-request required-check calibration

This calibration is designed to test whether GitHub branch protection binds a
successful required check to a pull request's current head SHA. It does not
claim that behavior has been proved until the complete live v2 sequence below
is observed and retained.

## Retained v1 discovery

The first fixed namespace remains evidence and must not be rewritten or
deleted:

- `calibration/g1/required-check/base`
- `calibration/g1/required-check/a`
- `calibration/g1/required-check/b`
- `calibration/g1/required-check/head`

The first setup attempt, [run 29437465131](https://github.com/fablebookjs/lab-01/actions/runs/29437465131),
failed safely before creating any required-check ref. Checkout v7 had persisted
its credential through local config
`includeif.gitdir:/home/runner/work/lab-01/lab-01/.git.path`, which the state
script rejected. The accepted state workflow keeps `persist-credentials: false`,
keeps all includes forbidden, and supplies its write token only through a
controlled GitHub-scoped child Git configuration.

The repaired manual-check experiment is retained as PR
[#19](https://github.com/fablebookjs/lab-01/pull/19) at A
`d81da764f7ca7b9ee3fcd4fb5186a81a14e1cd4e`. Workflow-dispatch runs
[29438908229](https://github.com/fablebookjs/lab-01/actions/runs/29438908229)
and [29439025160](https://github.com/fablebookjs/lab-01/actions/runs/29439025160)
both produced successful REST check runs with exact name
`Required calibration head`, GitHub Actions App ID `15368`, and head SHA A.
The exact old base protection had `strict=false`, `enforce_admins=true`, and
only that context/App pair. Nevertheless, the PR's current GraphQL commit had
`statusCheckRollup=null` and `mergeStateStatus=BLOCKED` after both runs. The
second run occurred after protection was active.

That evidence distinguishes a REST check run existing on a commit from the
check being associated with the pull request's `statusCheckRollup`. A manual
`workflow_dispatch` run does not provide the PR association needed by this
experiment. PR #19, its four refs, protection, workflow runs, and responses are
retained; v2 uses a new namespace instead of reinterpreting or overwriting them.

## V2 mechanism and fixed boundary

The manual **Calibrate required-check PR state** workflow dispatches only from
trusted `main` and owns exactly:

- `calibration/g1/required-check-pr/base`
- `calibration/g1/required-check-pr/a`
- `calibration/g1/required-check-pr/b`
- `calibration/g1/required-check-pr/head`

`setup` deterministically creates `base -> A -> B` and initializes `head=A`.
`advance-head` performs the only mutable transition, guarded A-to-B. Every ref
creation and transition uses an exact old-SHA lease, explicit `SHA:ref`
refspec, and `--no-follow-tags`. Reruns converge on an exact retained state or
fail closed. No workflow deletes refs or writes any old namespace.

Before Git advertisement or write, the state script rejects inherited Git
environment overrides, isolates global/system configuration, and audits local
configuration against a credential-free allowlist. Local include/includeIf,
HTTP headers, proxies, TLS/CA/certificate/low-speed settings, credential
helpers, URL rewrites, and transport helper overrides fail before network Git.
The state checkout uses `persist-credentials: false`; only its script step
receives `${{ github.token }}`. The script removes that token from Git child
environments and internally supplies one exact
`http.https://github.com/.extraheader` through controlled `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0`. It never places the token or
encoded header in arguments, logs, summaries, or errors.

The separate **Required check calibration** workflow has only `contents: read`
and one stable job/context, **Required calibration head**. It triggers only for
`pull_request` actions `opened`, `synchronize`, `reopened`, and `edited` whose
base is the exact v2 base branch. It checks out exact
`github.event.pull_request.base.sha` with `persist-credentials: false`, then
runs the trusted base copy of the checker. It never checks out or executes PR
head code, calls an API, or mutates a PR.

The `synchronize` trigger remains useful evidence for natural human-authored
head updates, but the acceptance sequence does not depend on a synchronize run
from the state workflow's `GITHUB_TOKEN` ref update. The retained authority
baseline shows that token-authored writes do not recursively trigger dependable
workflows. Consequently, both decisive B checks below are woken by explicit
authenticated human PR-body edits.

The checker reads `GITHUB_EVENT_PATH` and requires the exact repository and
event, a matching positive PR number other than protected evidence PRs 12, 16,
and 19, an open non-draft non-merged same-repository PR, exact fixed base/head
refs, lowercase 40-hex base/head identities, action-specific webhook fields,
and local `HEAD` equal to the event base SHA. Immediately before authorization,
it performs one credential-free public `git ls-remote --refs` request for exactly
the new base ref, new head ref, and `refs/pull/<PR>/merge`. Its strict parser
rejects missing, duplicate, unknown, malformed, or extra-field records. The
event base SHA must equal the current remote base, the event head SHA must equal
the current remote head, and `GITHUB_SHA` must equal the current remote pull
merge ref. The read retains the same isolated Git configuration and exact
trusted origin validation as the state workflow, but receives no token.

The PR body provides the durable explicit authorization. It must contain
exactly one machine line, with no indentation or suffix:

```text
Authorized-Head-SHA: <lowercase 40-hex current head SHA>
```

Absent, duplicate, malformed, or non-current authorization fails the stable
check. This proves current-head binding plus an explicit PR-body wake-up. It
does not prove the identity, entitlement, or policy right of the maintainer who
edits that body.

The current-ref observation is necessarily a point-in-time check: a ref can race
after the advertisement. That bounded race cannot let the resulting old check
satisfy protection for a newer current PR head, because GitHub associates the
check run with the pull-request event's merge/head state rather than whatever
the fixed ref points to later. The live sequence must still observe the PR
rollup and policy transitions below; that observation, not this inference
alone, is the product proof.

## Authoritative live evidence contract

Use one new stable `PR` number for all v2 phases. Never merge, close, or draft
the PR. Preserve raw REST and GraphQL responses for `a-green`, `b-failing`, and
`b-green`.

The observations are deliberately separate:

- GraphQL `mergeable` is graph mergeability only. It must be `MERGEABLE`.
- GraphQL `mergeStateStatus` is the policy-aware state.
- The current commit's GraphQL `statusCheckRollup` proves PR association.
- REST check runs provide exact check SHA, context, conclusion, details URL,
  and App provenance. The current GraphQL schema does not expose the needed
  CheckRun App field; do not add `app` to the GraphQL fragment. App ID and slug
  come from REST only.

Use REST API version `2026-03-10` and the new fixed namespace:

```sh
REPO=fablebookjs/lab-01
BASE=calibration/g1/required-check-pr/base
HEAD=calibration/g1/required-check-pr/head
ENCODED_BASE=$(jq -rn --arg value "$BASE" '$value | @uri')
```

For each exact phase SHA, retain all check runs and select the newest completed
exact context/App run:

```sh
gh api --paginate \
  --slurp \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/commits/$SHA/check-runs?filter=all&per_page=100" \
  > "$PHASE-check-runs.json"

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

jq -e --arg sha "$SHA" --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
  '[.[].check_runs[] |
    select(.head_sha == $sha and .name == $context and .app.id == $app_id)] |
   sort_by(.id) | last | select(. != null) |
   {name, head_sha, status, conclusion,
    app: {id: .app.id, slug: .app.slug}, html_url}' \
  "$PHASE-check-runs.json"
```

The REST tuple is
`(name, head_sha, status, conclusion, app.id, app.slug, html_url)`. Require the
exact stable name, phase head SHA, completed status, and the same numeric
GitHub Actions App ID in every phase.

Read branch protection before every policy decision:

```sh
gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/branches/$ENCODED_BASE/protection" \
  > "$PHASE-protection.json"

jq -e --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
  '.required_status_checks.strict == false and
   .enforce_admins.enabled == true and
   (.required_status_checks.checks | length) == 1 and
   .required_status_checks.checks[0].context == $context and
   .required_status_checks.checks[0].app_id == $app_id' \
  "$PHASE-protection.json"
```

The required tuple is exact
`(required_status_checks.strict=false, enforce_admins.enabled=true,
required_status_checks.checks=[{context: CONTEXT, app_id: APP_ID}])`.

Poll every five seconds for at most five minutes after every PR/ref/check
transition. Save every response. A response is terminal only when `headRefOid`
is the expected SHA, `mergeable` and `mergeStateStatus` are not `UNKNOWN`,
`contexts.totalCount <= 100`, and the current commit's exact context is
completed:

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

```sh
gh api graphql \
  -f query="$(cat required-check-calibration.graphql)" \
  -f owner=fablebookjs \
  -f name=lab-01 \
  -F number="$PR" \
  > "$PHASE-policy.json"
```

Every phase must retain this invariant PR tuple:
`(number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null,
baseRefName=BASE, baseRefOid=BASE_SHA, headRefName=HEAD)`. The sole commit from
`commits(last:1)` must have `oid=headRefOid`, and the exact stable CheckRun must
be present in that current commit's rollup.

| Phase | PR head / body authorization | Latest exact REST check | GraphQL `(mergeable, mergeStateStatus, rollup.state)` |
| --- | --- | --- | --- |
| `a-green` | A / A after `opened` | `(A, completed, success, APP_ID, github-actions)` | `(MERGEABLE, CLEAN, SUCCESS)` |
| `b-failing` | B / A after authenticated human `edited` wake-up | `(B, completed, failure, APP_ID, github-actions)`; A success remains retained on A | `(MERGEABLE, UNSTABLE, FAILURE)` |
| `b-green` | B / B after second authenticated human `edited` authorization | newest exact B run `(B, completed, success, APP_ID, github-actions)` | `(MERGEABLE, CLEAN, SUCCESS)` |

If GitHub reports `BLOCKED` rather than `UNSTABLE` for the completed B failure,
retain that raw policy-aware result and stop: it still demonstrates policy
blocking, but it is not the exact expected tuple and must not be rewritten as a
successful calibration. Any timeout, pagination overflow, extra protected
check, changed PR number, missing PR rollup, or draft/closed/merged PR also
fails the evidence contract.

## Live operator sequence

1. Install this revision through the normal repository process. From trusted
   `main`, create only the new v2 graph:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=setup
   ```

2. Record exact `BASE_SHA`, A, and B from the completed state summary. Create
   one new normal, non-draft same-repository PR from
   `calibration/g1/required-check-pr/head` to
   `calibration/g1/required-check-pr/base`. Its body must contain exactly
   `Authorized-Head-SHA: A`. Do not reuse PRs 12, 16, or 19. The `opened` run
   must execute the trusted base checkout and attach a successful
   **Required calibration head** check to exact A's PR rollup.

3. Query exact A, set `CONTEXT` and `APP_ID` from the successful REST run, then
   protect only the new base with strict false, enforced admins, and that one
   exact context/App pair. Generate the complete protection payload explicitly:

   ```sh
   jq -n --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
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

   Read protection back and poll until exact `a-green` is terminal.

4. Advance only the new `head` from A to B:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo fablebookjs/lab-01 \
     --ref main \
     -f mode=advance-head
   ```

   Read back the same PR and exact remote refs. Record whether a `synchronize`
   run is absent, awaiting approval, queued/running, or completed. Preserve it
   as evidence if present, but do not wait for it or use it as the required
   B/A failure. Acceptance must not depend on token-authored synchronize.

5. Before authorizing B, require the authenticated human operator. The commands
   below avoid shell evaluation of PR text: `jq` writes a fixed body file and
   `gh pr edit --body-file` passes the file directly. `PR`, `A`, and `B` must be
   literal values already recorded by the operator; do not populate them by
   evaluating untrusted PR content.

   First record the authenticated identity and the pre-edit workflow-run set:

   ```sh
   gh api user > b-failing-operator.json
   jq -e '.login == "ndelangen"' b-failing-operator.json

   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-failing-runs-before.json
   ```

   Stop unless the identity assertion succeeds. Generate a body which retains
   exact authorization A and adds one clearly non-authoritative evidence line,
   then use the authenticated human session to edit the same PR:

   ```sh
   jq -n -j --arg sha "$A" \
     '"Required-check calibration v2.\n\nAuthorized-Head-SHA: \($sha)\nCalibration-Wake-Up-Evidence: b-stale-authorization"' \
     > b-failing-body.md

   gh pr edit "$PR" \
     --repo "$REPO" \
     --body-file b-failing-body.md

   gh pr view "$PR" \
     --repo "$REPO" \
     --json number,state,isDraft,headRefName,headRefOid,baseRefName,body \
     > b-failing-pr.json

   jq -e --argjson number "$PR" --arg head "$B" --rawfile expected b-failing-body.md \
     '.number == $number and .state == "OPEN" and .isDraft == false and
      .baseRefName == "calibration/g1/required-check-pr/base" and
      .headRefName == "calibration/g1/required-check-pr/head" and
      .headRefOid == $head and .body == $expected' \
     b-failing-pr.json
   ```

   Treat any failed identity or PR readback assertion as a stop. Read the exact
   current merge ref without executing its contents and validate its one-record
   shape:

   ```sh
   git ls-remote --refs \
     https://github.com/fablebookjs/lab-01.git \
     "refs/pull/$PR/merge" \
     > b-failing-merge-ref.txt

   jq -Rsre --arg ref "refs/pull/$PR/merge" \
     'split("\n") | map(select(length > 0)) as $lines |
      select(($lines | length) == 1) |
      ($lines[0] | capture("^(?<sha>[0-9a-f]{40})\\t(?<ref>[^\\t ]+)$")) |
      select(.ref == $ref) | .sha' \
     b-failing-merge-ref.txt \
     > b-failing-merge-sha.txt

   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-failing-runs-after.json

   jq -ce \
     --slurpfile before b-failing-runs-before.json \
     --arg head "$B" \
     --arg conclusion failure \
     '[.workflow_runs[] | . as $run |
       select(([$before[0].workflow_runs[].id] | index($run.id)) == null) |
       select(.event == "pull_request" and
              .actor.login == "ndelangen" and
              .path == ".github/workflows/calibrate-required-check.yml" and
              .head_branch == "calibration/g1/required-check-pr/head" and
              .head_sha == $head and
              .status == "completed" and
              .conclusion == $conclusion)] as $runs |
      select(($runs | length) == 1) | $runs[0]' \
     b-failing-runs-after.json \
     > b-failing-run.json

   jq -r '.id' b-failing-run.json > b-failing-run-id.txt
   read -r B_FAILING_RUN_ID < b-failing-run-id.txt
   read -r B_FAILING_MERGE_SHA < b-failing-merge-sha.txt
   gh run view "$B_FAILING_RUN_ID" --repo "$REPO" --log > b-failing-run.log

   rg -F '"action": "edited"' b-failing-run.log
   rg -F "\"number\": $PR" b-failing-run.log
   rg -F "\"headSha\": \"$B\"" b-failing-run.log
   rg -F "\"authorizedSha\": \"$A\"" b-failing-run.log
   rg -F "\"remoteHeadSha\": \"$B\"" b-failing-run.log
   rg -F "\"remoteMergeSha\": \"$B_FAILING_MERGE_SHA\"" b-failing-run.log

   gh api --paginate \
     --slurp \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/commits/$B/check-runs?filter=all&per_page=100" \
     > b-failing-check-runs.json

   jq -ce \
     --arg sha "$B" \
     --arg context "$CONTEXT" \
     --argjson app_id "$APP_ID" \
     --arg run "/actions/runs/$B_FAILING_RUN_ID/" \
     '[.[].check_runs[] |
       select(.head_sha == $sha and
              .name == $context and
              .app.id == $app_id and
              .status == "completed" and
              .conclusion == "failure" and
              (.details_url | contains($run)))] |
      sort_by(.id) | last | select(. != null)' \
     b-failing-check-runs.json \
     > b-failing-check.json
   ```

   Repeat the after-read and exclusion query every five seconds for at most five
   minutes until the exact run is completed; never select a pre-edit run. The
   exclusion query above must select exactly the new human run: event
   `pull_request`, actor `ndelangen`, exact workflow path, fixed head branch,
   completed failure, and REST workflow-run `head_sha=B`. Its retained logs must
   report action `edited`, exact `PR`, event head B, remote head B, PR-body
   authorization A, and checker `remoteMergeSha` equal to the separately
   advertised `refs/pull/PR/merge` SHA. The checker already enforces that
   `GITHUB_SHA` equals that remote merge SHA. Then use the paginated REST
   check-run query on exact B and require the same context/App pair with
   completed `failure`; the selected check details must belong to
   `B_FAILING_RUN_ID`. Poll GraphQL for exact `b-failing` and confirm A's success
   remains retained.

   The B/A evidence tuple deliberately distinguishes the identities:
   `(run.head_sha=B, checker.headSha=B, checker.remoteHeadSha=B,
   checker.remoteMergeSha=advertised refs/pull/PR/merge SHA,
   checker.authorizedSha=A, check.conclusion=failure)`.

   If the human `edited` run does not appear, awaits approval that cannot be
   granted, does not execute, has the wrong actor/ref/SHA/action/PR, or lacks the
   exact B/A failure context, stop. Do not change authorization to B.

6. Only after exact `b-failing` is retained, make a second authenticated human
   edit. The deterministic body below differs from the prior body only in the
   authorization SHA; its non-authoritative wake-up/evidence line is unchanged:

   ```sh
   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-green-runs-before.json

   jq -n -j --arg sha "$B" \
     '"Required-check calibration v2.\n\nAuthorized-Head-SHA: \($sha)\nCalibration-Wake-Up-Evidence: b-stale-authorization"' \
     > b-green-body.md

   gh pr edit "$PR" \
     --repo "$REPO" \
     --body-file b-green-body.md

   gh pr view "$PR" \
     --repo "$REPO" \
     --json number,state,isDraft,headRefName,headRefOid,baseRefName,body \
     > b-green-pr.json

   jq -e --argjson number "$PR" --arg head "$B" --rawfile expected b-green-body.md \
     '.number == $number and .state == "OPEN" and .isDraft == false and
      .baseRefName == "calibration/g1/required-check-pr/base" and
      .headRefName == "calibration/g1/required-check-pr/head" and
      .headRefOid == $head and .body == $expected' \
     b-green-pr.json
   ```

   Repeat the before/after run-set exclusion from step 5 with
   `--arg head "$B"` and `--arg conclusion success`. Repeat the exact actor,
   workflow, action, PR, context, and App checks. REST workflow-run `head_sha`
   must again be B; it must not be the synthetic merge SHA. Separately require
   checker `remoteMergeSha` to equal the freshly advertised pull merge SHA. The
   new human `edited` run must produce exact B/B success. Poll for exact
   `b-green`, reread protection, and verify the stable PR remains open,
   non-draft, and never merged.

   The B/B evidence tuple is
   `(run.head_sha=B, checker.headSha=B, checker.remoteHeadSha=B,
   checker.remoteMergeSha=advertised refs/pull/PR/merge SHA,
   checker.authorizedSha=B, check.conclusion=success)`.

   These explicit human PR interactions are compatible with the product model
   in which a maintainer authorizes release movement. They do not prove fully
   autonomous dependent workflow dispatch after a `GITHUB_TOKEN` ref write.

7. Retain the v2 PR, all new refs, runs, REST/GraphQL/protection responses, and
   the complete old v1 evidence. Cleanup is a separate authorized operation.

## Preservation boundary and non-goals

Neither workflow modifies `releases/v1.0`, `staged/v1.0`, release PR #12,
conflict-recovery PR #16, failed/manual calibration PR #19, either old
required-check namespace, any other prior calibration ref, any tag or GitHub
Release, package publication state, infra repository policy, or Storybook
resources. The workflows do not create, edit, close, or merge pull requests and
do not configure branch protection. This slice does not prove production
credential suitability, maintainer entitlement, strict base synchronization,
recovery completion, publication, or the wider G1 lifecycle.
