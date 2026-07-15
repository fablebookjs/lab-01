# Current-head required-check calibration

This calibration tests whether GitHub branch protection binds a successful
required check to a pull request's current head SHA. It does not claim v3 proof
until the complete live sequence below is observed and retained.

## Retained discoveries from v1 and v2

All prior namespaces, PRs, protection, and runs are evidence. Do not rewrite or
delete them.

### V1: a manual check run is not a PR rollup

The first namespace remains:

- `calibration/g1/required-check/{base,a,b,head}`

[Run 29437465131](https://github.com/fablebookjs/lab-01/actions/runs/29437465131)
failed safely before creating its refs because checkout v7 had persisted an
`includeIf` credential file. The accepted state implementation keeps
`persist-credentials: false`, forbids include/includeIf, and supplies write
authentication only through controlled GitHub-scoped child Git configuration.

PR [#19](https://github.com/fablebookjs/lab-01/pull/19) and successful manual
runs [29438908229](https://github.com/fablebookjs/lab-01/actions/runs/29438908229)
and [29439025160](https://github.com/fablebookjs/lab-01/actions/runs/29439025160)
are retained. REST showed context **Required calibration head**, App ID `15368`,
and exact A, but GraphQL remained `statusCheckRollup=null` and
`mergeStateStatus=BLOCKED`. A `workflow_dispatch` CheckRun existing on a commit
did not provide the PR rollup association required by this experiment.

### V2: a later same-context success does not erase an earlier failure

The second namespace and PR remain:

- `calibration/g1/required-check-pr/{base,a,b,head}`
- PR [#21](https://github.com/fablebookjs/lab-01/pull/21)

V2 reached exact B `fc7876e24d3e55e326862c9495481eb3bc07f049`
from A `07a51d4dda009d2e60c3390f4a3e4ea9dd9a75eb`. The bot-authored
`synchronize` run
[29443682944](https://github.com/fablebookjs/lab-01/actions/runs/29443682944)
is retained as `action_required`.

Before any B required check existed, the old successful A check remained
retained, the current B commit had no **Required calibration head** CheckRun or
rollup, and policy was `MERGEABLE/BLOCKED/null`. That is the already-observed
stale-green rejection: A's green result did not authorize current B.

The human `edited` B/A run
[29443714934](https://github.com/fablebookjs/lab-01/actions/runs/29443714934)
then produced an intentional exact failure on B. Its checker retained
`action=edited`, `headSha=remoteHeadSha=B`, `authorizedSha=A`, and
`remoteMergeSha=a150bbdfb4f1afd9350020ef717206d59a56678e`. The exact App
`15368`/context/B CheckRun concluded `failure`, and GraphQL was
`MERGEABLE/BLOCKED/FAILURE`.

The later human `edited` B/B run
[29444330224](https://github.com/fablebookjs/lab-01/actions/runs/29444330224)
is an exact checker success on the same B and same context. GitHub nevertheless
aggregates both same-context CheckRuns on that SHA: the final v2 GraphQL state is
`mergeStateStatus=UNSTABLE` and `statusCheckRollup.state=FAILURE`.

This is retained negative evidence, not failure hiding. A same-name failure and
success on one SHA aggregate to failure; an intentional failing required check
must not be used as a reauthorization phase. V2 PR #21, its four refs,
protection, failure, success, and final tuple must remain untouched.

## V3 fixed mechanism

The manual **Calibrate current required-check state** workflow dispatches only
from trusted `main` and owns exactly:

- `calibration/g1/required-check-current/base`
- `calibration/g1/required-check-current/a`
- `calibration/g1/required-check-current/b`
- `calibration/g1/required-check-current/head`

`setup` deterministically creates `base -> A -> B` and initializes `head=A`.
`advance-head` performs the only mutable transition, guarded A-to-B. Every ref
creation and update uses an exact old-SHA lease, explicit `SHA:ref` refspec, and
`--no-follow-tags`. Reruns converge on exact retained state or fail closed.

Before Git advertisement or write, the state script rejects inherited Git
environment overrides, isolates global/system configuration, and audits local
configuration against a credential-free allowlist. Proxy, TLS/CA/certificate,
credential-helper, header, URL-rewrite, helper, and include/includeIf overrides
fail before network Git. The token is removed from child environments and used
only as one internally constructed `http.https://github.com/.extraheader` via
controlled `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0`.

The separate **Required check calibration** workflow has only `contents: read`,
one job/context named **Required calibration head**, and triggers only for
`pull_request` actions `opened`, `reopened`, and `edited` on exact v3 base.
There is deliberately no `synchronize` trigger. Therefore the bot A-to-B ref
transition cannot emit a required-context failure that poisons B.

The workflow never executes head code. It checks out exact event
`pull_request.base.sha` with `persist-credentials: false` and runs the trusted
base checker. The checker rejects protected evidence PRs 12, 16, 19, and 21;
wrong repository/event/ref/state/identity; forks; draft/closed/merged PRs;
malformed SHAs/body/event files; hostile Git configuration; and stale refs. It
opens `GITHUB_EVENT_PATH` using `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, requires a
bounded regular file, and rejects FIFOs and symlinks.

Immediately before authorization it performs one credential-free public
`git ls-remote --refs` for exact v3 base, v3 head, and
`refs/pull/<PR>/merge`. Its strict parser rejects missing, duplicate, unknown,
malformed, and extra-field records. Event base/head must equal current remote
base/head; `GITHUB_SHA` must equal the current advertised pull merge ref; local
`HEAD` must equal trusted event base.

The PR body must contain exactly one unindented machine line:

```text
Authorized-Head-SHA: <lowercase 40-hex current head SHA>
```

## Exact v3 evidence contract

Use one new stable normal, non-draft PR. Never merge, close, or draft it.
Protection on only the v3 base must be exact
`(strict=false, enforce_admins=true, checks=[{context: CONTEXT, app_id: APP_ID}])`.

| Phase | Required-context state on current head | GraphQL `(mergeable, mergeStateStatus, rollup.state)` |
| --- | --- | --- |
| `a-green` | exact A has one successful context/App CheckRun | `(MERGEABLE, CLEAN, SUCCESS)` |
| `b-before-edit` | exact B has zero context/App CheckRuns; A success remains retained | `(MERGEABLE, BLOCKED, null)` |
| `b-after-edit` | exact B has exactly one new human `edited` successful context/App CheckRun | `(MERGEABLE, CLEAN, SUCCESS)` |

The `b-before-edit` phase is the required stale-green proof. If any
**Required calibration head** CheckRun exists on B before the human edit, stop
and abandon the v3 namespace. Do not try to recover it with another same-context
run.

REST supplies exact App provenance; the GraphQL CheckRun fragment intentionally
does not request an unsupported App field. Save this query as
`required-check-calibration.graphql`:

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
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
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

Poll every five seconds for at most five minutes. A phase is terminal only when
the invariant PR tuple is
`(number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null,
baseRefName=BASE, baseRefOid=BASE_SHA, headRefName=HEAD)`, the returned commit
OID equals `headRefOid`, and all phase-specific conditions are exact.

## Live v3 operator sequence

Set `REPO`, `BASE`, and `HEAD` to literal trusted values; record `PR`, A, B, and
`BASE_SHA` from retained operator output rather than evaluating PR text:

```sh
REPO=fablebookjs/lab-01
BASE=calibration/g1/required-check-current/base
HEAD=calibration/g1/required-check-current/head
```

1. Install v3 normally. Dispatch state setup from trusted `main`:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo "$REPO" \
     --ref main \
     -f mode=setup
   ```

2. Create one new same-repository PR from v3 head to v3 base whose body
   authorizes exact A. The `opened` check must be A's first exact context and
   succeed. Read its REST CheckRun to bind `CONTEXT` and `APP_ID`; protect only
   v3 base with strict false, enforced admins, and that one context/App pair.
   Poll until `a-green` is exact `MERGEABLE/CLEAN/SUCCESS`.

3. Advance only v3 head A-to-B through the state workflow:

   ```sh
   gh workflow run calibrate-required-check-state.yml \
     --repo "$REPO" \
     --ref main \
     -f mode=advance-head
   ```

   The state run is the exact transition evidence. Because the required workflow
   has no `synchronize` trigger, it must not create a B required check. Retain all
   B CheckRuns and require zero exact context/App matches:

   ```sh
   gh api --paginate \
     --slurp \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/commits/$B/check-runs?filter=all&per_page=100" \
     > b-before-edit-check-runs.json

   jq -ce --arg head "$B" --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
     '[.[].check_runs[] |
       select(.head_sha == $head and .name == $context and .app.id == $app_id)] |
      select(length == 0)' \
     b-before-edit-check-runs.json \
     > b-before-edit-required-checks.json
   ```

   Query GraphQL and require exact B with
   `(MERGEABLE, BLOCKED, statusCheckRollup=null)`. Query A separately and retain
   its successful required CheckRun. This is the stale-green rejection. If the
   zero-check assertion fails or rollup is non-null, stop and abandon v3 without
   editing authorization.

4. Authenticate the human operator and snapshot the pre-edit workflow runs:

   ```sh
   gh api user > b-after-edit-operator.json
   jq -e '.login == "ndelangen"' b-after-edit-operator.json

   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-after-edit-runs-before.json
   ```

   Stop unless identity and `b-before-edit` evidence are exact. Make one body
   edit directly from authorization A to B; do not create an intentional B/A
   required run:

   ```sh
   jq -n -j --arg sha "$B" \
     '"Required-check calibration v3.\n\nAuthorized-Head-SHA: \($sha)"' \
     > b-after-edit-body.md

   gh pr edit "$PR" --repo "$REPO" --body-file b-after-edit-body.md

   gh pr view "$PR" \
     --repo "$REPO" \
     --json number,state,isDraft,headRefName,headRefOid,baseRefName,body \
     > b-after-edit-pr.json

   jq -e --argjson number "$PR" --arg head "$B" --rawfile expected b-after-edit-body.md \
     '.number == $number and .state == "OPEN" and .isDraft == false and
      .baseRefName == "calibration/g1/required-check-current/base" and
      .headRefName == "calibration/g1/required-check-current/head" and
      .headRefOid == $head and .body == $expected' \
     b-after-edit-pr.json
   ```

5. Read and strictly parse the current pull merge ref, then select exactly one
   new completed human `edited` success at REST workflow-run `head_sha=B`:

   ```sh
   git ls-remote --refs \
     https://github.com/fablebookjs/lab-01.git \
     "refs/pull/$PR/merge" \
     > b-after-edit-merge-ref.txt

   jq -Rsre --arg ref "refs/pull/$PR/merge" \
     'split("\n") | map(select(length > 0)) as $lines |
      select(($lines | length) == 1) |
      ($lines[0] | capture("^(?<sha>[0-9a-f]{40})\\t(?<ref>[^\\t ]+)$")) |
      select(.ref == $ref) | .sha' \
     b-after-edit-merge-ref.txt \
     > b-after-edit-merge-sha.txt

   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-after-edit-runs-after.json

   jq -ce \
     --slurpfile before b-after-edit-runs-before.json \
     --arg head "$B" \
     '[.workflow_runs[] | . as $run |
       select(([$before[0].workflow_runs[].id] | index($run.id)) == null) |
       select(.event == "pull_request" and
              .actor.login == "ndelangen" and
              .path == ".github/workflows/calibrate-required-check.yml" and
              .head_branch == "calibration/g1/required-check-current/head" and
              .head_sha == $head and
              .status == "completed" and
              .conclusion == "success")] as $runs |
      select(($runs | length) == 1) | $runs[0]' \
     b-after-edit-runs-after.json \
     > b-after-edit-run.json
   ```

   Retain the run logs and require checker `action=edited`, exact PR, B/B,
   `remoteHeadSha=B`, and `remoteMergeSha` equal to the separately advertised
   merge SHA. The checker already enforces `GITHUB_SHA=remoteMergeSha`.

6. Query exact B CheckRuns again. Require exactly one exact context/App match,
   bound to the new human run, with completed `success`. Poll GraphQL until exact
   `(MERGEABLE, CLEAN, SUCCESS)`. Re-read protection and verify the stable PR was
   never merged.

7. Retain the v3 PR, refs, state runs, check runs, protection, REST, and GraphQL
   evidence. Cleanup is a separate explicitly authorized operation.

## Preservation boundary and non-goals

The v3 workflows must not modify v1 or v2 namespaces, PRs 19 or 21, release PR
#12, conflict-recovery PR #16, `releases/v1.0`, `staged/v1.0`, any other prior
calibration ref, tags, GitHub Releases, package publication, infra policy, or
Storybook resources. They do not create/edit/merge PRs or configure protection.
This calibration proves current-head required-check binding if and only if the
exact live v3 tuples are retained. It does not prove fully autonomous dependent
dispatch, maintainer entitlement, release completion, publication, or the wider
G1 lifecycle.
