# Current-head required-check calibration

This calibration tests whether GitHub branch protection binds a successful
required check to a pull request's current head SHA. The completed v3 live proof
and its exact preservation snapshot are retained below.

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

## V3: completed current-head binding proof

V3 was installed by [PR #22](https://github.com/fablebookjs/lab-01/pull/22),
merged at trusted `main` commit
`581e096a5c58ce5d904bb18a99b6c1fdc594ab43`. State setup
[run 29449811320](https://github.com/fablebookjs/lab-01/actions/runs/29449811320)
created exactly:

| Fixed ref | Retained SHA after setup |
| --- | --- |
| `calibration/g1/required-check-current/base` | `4c734933625e643a97928514649b1302697e86db` |
| `calibration/g1/required-check-current/a` | `eb2aaae563a1d25d6ba16a10da69ab7e0644af6f` |
| `calibration/g1/required-check-current/b` | `fd7773ad426f620a3e98603cb72887a705c85cbe` |
| `calibration/g1/required-check-current/head` | initially A `eb2aaae563a1d25d6ba16a10da69ab7e0644af6f` |

The retained evidence PR is
[#23](https://github.com/fablebookjs/lab-01/pull/23). It remains open,
non-draft, unmerged, and bound to the fixed v3 base and head refs.

### A green

The PR `opened` event produced
[run 29449854427](https://github.com/fablebookjs/lab-01/actions/runs/29449854427)
and exact successful
[job/CheckRun 87469366909](https://github.com/fablebookjs/lab-01/actions/runs/29449854427/job/87469366909)
on A `eb2aaae563a1d25d6ba16a10da69ab7e0644af6f`. REST bound it to App
ID `15368` and context **Required calibration head**. Exact v3 base protection
was `(strict=false, enforce_admins=true, checks=[{context: "Required calibration
head", app_id: 15368}])`. GraphQL was `MERGEABLE/CLEAN/SUCCESS`.

### B before authorization: stale-green rejection

State [run 29449898852](https://github.com/fablebookjs/lab-01/actions/runs/29449898852)
changed only v3 head from A
`eb2aaae563a1d25d6ba16a10da69ab7e0644af6f` to B
`fd7773ad426f620a3e98603cb72887a705c85cbe`. Before B authorization,
PR #23's body still authorized exact A while its current head was exact B.
There were zero required-workflow runs at B and zero B CheckRuns named
**Required calibration head**, regardless of App. GraphQL was exactly
`MERGEABLE/BLOCKED/null`.

This is the completed stale-green proof: A's retained success did not authorize
or make mergeable the newer current head B.

### B authorized green

Before the sole authorization edit, the retained A-authorizing PR body had
SHA-256 `d296653cb97e435b54fdcc4cd88c6b406176199cda16a44a91099d8c745ba44f`.
The separately advertised pull merge SHA was
`a748e2c7a2f6774a70d0324e98b04f7cea74eab8`.

One authenticated `ndelangen` body edit produced `pull_request` event
[run 29449963241](https://github.com/fablebookjs/lab-01/actions/runs/29449963241)
and successful
[job/CheckRun 87469722671](https://github.com/fablebookjs/lab-01/actions/runs/29449963241/job/87469722671).
REST bound the run to head B, exact PR #23 and its fixed base/head refs, App ID
`15368`, and context **Required calibration head**. The trusted checker retained:

- `priorAuthorizedSha=eb2aaae563a1d25d6ba16a10da69ab7e0644af6f`
- `authorizedSha=headSha=remoteHeadSha=fd7773ad426f620a3e98603cb72887a705c85cbe`
- `remoteASha=eb2aaae563a1d25d6ba16a10da69ab7e0644af6f`
- `remoteMergeSha=a748e2c7a2f6774a70d0324e98b04f7cea74eab8`
- `priorBodySha256=d296653cb97e435b54fdcc4cd88c6b406176199cda16a44a91099d8c745ba44f`
- `currentBodySha256=6fd20fe033ed89c02e0a294043fd92a44de7e8b18728977652360847fe662858`

B has exactly one same-name CheckRun, and final GraphQL is exactly
`MERGEABLE/CLEAN/SUCCESS`. The same required context therefore recovered only
after the exact current B authorization and B-bound success.

### Retained preservation snapshot

- `releases/v1.0` remains `0a9e2a9ae101ed71f83d9c4253bd7fe5c07f6e35`.
- `staged/v1.0` remains `4e9321b895f01394f79b1377d46b5348ac59601d`.
- PR #12 is open/draft; PR #16 is open/draft/conflicting; PR #19 is
  open/blocked; PR #21 is open/unstable; PR #23 is open/non-draft/unmerged.
- The only tag is `v1.0.0` at
  `b59edf1d4c0fff51295327e8ce9e72678c336156`; GitHub Releases remain zero.
- npm reads for `@fablebook/lab-01-core@1.0.1` and
  `@fablebook/lab-01-addon@1.0.1` both remain `E404`.
- All three calibration namespaces, retained PRs, and base protections remain
  intact. No cleanup is authorized or performed.

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

```sh
tee required-check-calibration.graphql >/dev/null <<'GRAPHQL'
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
GRAPHQL
```

Poll every five seconds for at most five minutes. A phase is terminal only when
the invariant PR tuple is
`(number=PR, state=OPEN, isDraft=false, merged=false, mergedAt=null,
baseRefName=BASE, baseRefOid=BASE_SHA, headRefName=HEAD)`, the returned commit
OID equals `headRefOid`, and all phase-specific conditions are exact.

Create these copy-safe selectors once. They are shared by every phase:

```sh
tee exact-policy.jq >/dev/null <<'JQ'
.repository.pullRequest as $pr |
$pr != null and
$pr.number == $number and
$pr.state == "OPEN" and
$pr.isDraft == false and
$pr.merged == false and
$pr.mergedAt == null and
$pr.baseRefName == $base and
$pr.baseRefOid == $base_oid and
$pr.headRefName == $head_ref and
$pr.headRefOid == $head and
$pr.mergeable == "MERGEABLE" and
$pr.mergeStateStatus == $policy and
($pr.commits.nodes | length) == 1 and
$pr.commits.nodes[0].commit.oid == $head and
(if $rollup == "null" then
   $pr.commits.nodes[0].commit.statusCheckRollup == null
 else
   ($pr.commits.nodes[0].commit.statusCheckRollup.state == $rollup and
    $pr.commits.nodes[0].commit.statusCheckRollup.contexts.totalCount <= 100)
 end)
JQ

tee exact-protection.jq >/dev/null <<'JQ'
.required_status_checks.strict == false and
.enforce_admins.enabled == true and
(.required_status_checks.checks | length) == 1 and
.required_status_checks.checks[0].context == $context and
.required_status_checks.checks[0].app_id == $app_id
JQ

tee exact-run.jq >/dev/null <<'JQ'
[.workflow_runs[] |
 select(.event == "pull_request" and
        .path == ".github/workflows/calibrate-required-check.yml" and
        .head_branch == $head_ref and
        .head_sha == $head and
        (.pull_requests | length) == 1 and
        .pull_requests[0].number == $number and
        .pull_requests[0].base.ref == $base and
        .pull_requests[0].head.ref == $head_ref and
        .pull_requests[0].head.sha == $head)] as $runs |
select(($runs | length) == 1) |
$runs[0] as $run |
select(([$before[0].workflow_runs[].id] | index($run.id)) == null) |
select($run.actor.login == "ndelangen" and
       $run.status == "completed" and
       $run.conclusion == $conclusion) |
$run
JQ

tee exact-check.jq >/dev/null <<'JQ'
[.[].check_runs[] |
 select(.head_sha == $head and
        .name == $context)] as $checks |
select(($checks | length) == 1) |
$checks[0] as $check |
select($check.app.id == $app_id and
       $check.status == "completed" and
       $check.conclusion == $conclusion and
       ($check.details_url | contains($run_path))) |
$check
JQ
```

For each phase, read and verify the exact protection. The percent-encoded v3
branch is literal, so no shell evaluation constructs the endpoint. Set `PHASE`
to the literal `a-green`, `b-before-edit`, or `b-after-edit` before each read:

```sh
gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/branches/calibration%2Fg1%2Frequired-check-current%2Fbase/protection" \
  > "$PHASE-protection.json"

jq -e --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
  -f exact-protection.jq \
  "$PHASE-protection.json"
```

For `a-green`, capture the GraphQL, workflow-run, and CheckRun evidence, then
apply full cardinality and linkage checks:

```sh
gh api --paginate --slurp \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/commits/$A/check-runs?filter=all&per_page=100" \
  > a-green-check-runs.json

jq -ce --arg head "$A" \
  '[.[].check_runs[] |
    select(.head_sha == $head and
           .name == "Required calibration head" and
           .app.slug == "github-actions" and
           .status == "completed" and
           .conclusion == "success")] as $checks |
   select(($checks | length) == 1) | $checks[0]' \
  a-green-check-runs.json > a-green-bootstrap-check.json

jq -r '.name' a-green-bootstrap-check.json > context.txt
jq -r '.app.id' a-green-bootstrap-check.json > app-id.txt
read -r CONTEXT < context.txt
read -r APP_ID < app-id.txt

gh api graphql \
  -F query=@required-check-calibration.graphql \
  -f owner=fablebookjs \
  -f name=lab-01 \
  -F number="$PR" \
  > a-green-policy.json

jq -e --argjson number "$PR" --arg base "$BASE" --arg base_oid "$BASE_SHA" \
  --arg head_ref "$HEAD" --arg head "$A" --arg policy CLEAN --arg rollup SUCCESS \
  -f exact-policy.jq a-green-policy.json

jq -n '{workflow_runs: []}' > a-green-runs-before.json
gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
  > a-green-runs-after.json

jq -ce --slurpfile before a-green-runs-before.json \
  --argjson number "$PR" --arg base "$BASE" --arg head_ref "$HEAD" --arg head "$A" \
  --arg conclusion success -f exact-run.jq a-green-runs-after.json \
  > a-green-run.json

jq -r '.id' a-green-run.json > a-green-run-id.txt
read -r A_RUN_ID < a-green-run-id.txt

jq -ce --arg head "$A" --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
  --arg conclusion success --arg run_path "/actions/runs/$A_RUN_ID/" \
  -f exact-check.jq a-green-check-runs.json > a-green-check.json
```

For `b-before-edit`, use the same full PR/protection selector and require both
zero same-name CheckRuns across every App and a null rollup:

```sh
gh api graphql \
  -F query=@required-check-calibration.graphql \
  -f owner=fablebookjs \
  -f name=lab-01 \
  -F number="$PR" \
  > b-before-edit-policy.json

jq -e --argjson number "$PR" --arg base "$BASE" --arg base_oid "$BASE_SHA" \
  --arg head_ref "$HEAD" --arg head "$B" --arg policy BLOCKED --arg rollup null \
  -f exact-policy.jq b-before-edit-policy.json

gh api --paginate --slurp \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/commits/$B/check-runs?filter=all&per_page=100" \
  > b-before-edit-check-runs.json

gh api \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
  > b-before-edit-runs.json

jq -ce --argjson number "$PR" --arg base "$BASE" --arg head_ref "$HEAD" --arg head "$B" \
  '[.workflow_runs[] |
    select(.event == "pull_request" and
           .path == ".github/workflows/calibrate-required-check.yml" and
           .head_branch == $head_ref and .head_sha == $head and
           (.pull_requests | length) == 1 and
           .pull_requests[0].number == $number and
           .pull_requests[0].base.ref == $base and
           .pull_requests[0].head.ref == $head_ref and
           .pull_requests[0].head.sha == $head)] |
   select(length == 0)' \
  b-before-edit-runs.json > b-before-edit-required-runs.json

jq -ce --arg head "$B" --arg context "$CONTEXT" \
  '[.[].check_runs[] | select(.head_sha == $head and .name == $context)] |
   select(length == 0)' \
  b-before-edit-check-runs.json > b-before-edit-required-checks.json
```

For `b-after-edit`, apply the full PR/protection selector, then bind the one
exact B CheckRun to the one selected new human run:

```sh
gh api graphql \
  -F query=@required-check-calibration.graphql \
  -f owner=fablebookjs \
  -f name=lab-01 \
  -F number="$PR" \
  > b-after-edit-policy.json

jq -e --argjson number "$PR" --arg base "$BASE" --arg base_oid "$BASE_SHA" \
  --arg head_ref "$HEAD" --arg head "$B" --arg policy CLEAN --arg rollup SUCCESS \
  -f exact-policy.jq b-after-edit-policy.json

jq -r '.id' b-after-edit-run.json > b-after-edit-run-id.txt
read -r B_AFTER_RUN_ID < b-after-edit-run-id.txt
gh api --paginate --slurp \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$REPO/commits/$B/check-runs?filter=all&per_page=100" \
  > b-after-edit-check-runs.json

jq -ce --arg head "$B" --arg context "$CONTEXT" --argjson app_id "$APP_ID" \
  --arg conclusion success --arg run_path "/actions/runs/$B_AFTER_RUN_ID/" \
  -f exact-check.jq b-after-edit-check-runs.json > b-after-edit-check.json
```

## Retained live v3 operator sequence

The evidence above records the completed execution. The commands below retain
the exact reproduction and verification procedure.

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
   B CheckRuns and require zero same-name matches across every App:

   ```sh
   gh api --paginate \
     --slurp \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/commits/$B/check-runs?filter=all&per_page=100" \
     > b-before-edit-check-runs.json

   jq -ce --arg head "$B" --arg context "$CONTEXT" \
     '[.[].check_runs[] |
       select(.head_sha == $head and .name == $context)] |
      select(length == 0)' \
     b-before-edit-check-runs.json \
     > b-before-edit-required-checks.json
   ```

   This poison scan deliberately ignores App, status, and conclusion. Any
   same-name CheckRun on B—including one from App `99999`—fails the gate.
   Query GraphQL and require exact B with
   `(MERGEABLE, BLOCKED, statusCheckRollup=null)`. Query A separately and retain
   its successful required CheckRun. This is the stale-green rejection. If the
   zero-check assertion fails or rollup is non-null, stop and abandon v3 without
   editing authorization.

4. Authenticate the human operator and snapshot the pre-edit workflow runs:

   ```sh
   gh api user > b-after-edit-operator.json
   jq -e '.login == "ndelangen"' b-after-edit-operator.json

   gh pr view "$PR" \
     --repo "$REPO" \
     --json number,state,isDraft,mergedAt,headRefName,headRefOid,baseRefName,body \
     > b-before-body-pr.json

   jq -e --argjson number "$PR" --arg head "$B" --arg authorized "$A" \
     '.number == $number and .state == "OPEN" and .isDraft == false and
      .mergedAt == null and
      .baseRefName == "calibration/g1/required-check-current/base" and
      .headRefName == "calibration/g1/required-check-current/head" and
      .headRefOid == $head and
      ([.body | split("\n")[] |
        select(contains("Authorized-Head-SHA:"))] ==
       ["Authorized-Head-SHA: " + $authorized])' \
     b-before-body-pr.json

   jq -rj '.body' b-before-body-pr.json > b-before-body.md
   node --input-type=module -e '
     import { readFileSync } from "node:fs";
     import { parseAuthorizedHead } from "./scripts/check-required-calibration-head.mjs";
     const actual = parseAuthorizedHead(readFileSync(process.argv[2], "utf8"));
     if (actual !== process.argv[1]) throw new Error("Pre-edit authorization is not exact A");
   ' "$A" b-before-body.md
   shasum -a 256 b-before-body.md > b-before-body.sha256

   gh api \
     -H 'X-GitHub-Api-Version: 2026-03-10' \
     "repos/$REPO/actions/workflows/calibrate-required-check.yml/runs?event=pull_request&per_page=100" \
     > b-after-edit-runs-before.json
   ```

   Retain the exact pre-edit body and SHA-256. Stop unless identity, sole exact A
   authorization, and `b-before-edit` evidence are exact. Make one body
   edit directly from authorization A to B; do not create an intentional B/A
   required run:

   ```sh
   jq -n -j --arg sha "$B" \
     '"Required-check calibration v3.\n\nAuthorized-Head-SHA: \($sha)"' \
     > b-after-edit-body.md
   shasum -a 256 b-after-edit-body.md > b-after-edit-body.sha256

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
     --argjson number "$PR" \
     --arg base "$BASE" \
     --arg head_ref "$HEAD" \
     --arg head "$B" \
     --arg conclusion success \
     -f exact-run.jq \
     b-after-edit-runs-after.json \
     > b-after-edit-run.json

   jq -r '.id' b-after-edit-run.json > b-after-edit-run-id.txt
   read -r B_AFTER_RUN_ID < b-after-edit-run-id.txt
   read -r B_MERGE_SHA < b-after-edit-merge-sha.txt
   read -r B_BEFORE_BODY_SHA B_BEFORE_BODY_FILE < b-before-body.sha256
   read -r B_AFTER_BODY_SHA B_AFTER_BODY_FILE < b-after-edit-body.sha256
   gh run view "$B_AFTER_RUN_ID" --repo "$REPO" --log > b-after-edit-run.log

   rg -F '"action": "edited"' b-after-edit-run.log
   rg -F "\"number\": $PR" b-after-edit-run.log
   rg -F "\"headSha\": \"$B\"" b-after-edit-run.log
   rg -F "\"remoteASha\": \"$A\"" b-after-edit-run.log
   rg -F "\"remoteHeadSha\": \"$B\"" b-after-edit-run.log
   rg -F "\"priorAuthorizedSha\": \"$A\"" b-after-edit-run.log
   rg -F "\"authorizedSha\": \"$B\"" b-after-edit-run.log
   rg -F "\"priorBodySha256\": \"$B_BEFORE_BODY_SHA\"" b-after-edit-run.log
   rg -F "\"currentBodySha256\": \"$B_AFTER_BODY_SHA\"" b-after-edit-run.log
   rg -F "\"remoteMergeSha\": \"$B_MERGE_SHA\"" b-after-edit-run.log
   ```

   These retained logs bind the event's strict `changes.body.from` parse to
   exact A and to the SHA-256 of the pre-edit body snapshot. They also require
   exact PR, B/B, remote A/B, and the separately advertised merge SHA. The
   checker already enforces `GITHUB_SHA=remoteMergeSha`.

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
The retained exact live v3 tuples prove current-head required-check binding.
They do not prove fully autonomous dependent dispatch, maintainer entitlement,
release completion, publication, or the wider G1 lifecycle.
