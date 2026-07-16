import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const calibration = readFileSync(
  new URL('../docs/recovery-terminal-calibration.md', import.meta.url),
  'utf8',
);
const demo = readFileSync(new URL('../docs/demo.md', import.meta.url), 'utf8');
const finalizer = readFileSync(new URL('../docs/finalize-release.md', import.meta.url), 'utf8');
const publicReleaseEvidence = readFileSync(
  new URL('../docs/issue-19-live-evidence.md', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const SOURCE = 'e43ec8e1fc5904dabc9bc394b804b6e0faf3ec37';
const RECOVERY = '019d79a611ee6c89a19e5369ddfb79ebd14efc62';
const MERGE = '77a46f4ddf7eedb097e8447b335f6c791472d15e';
const PROPOSAL = 'b1a266b6c5b1424b336bc102b9876f2912e5c0d3';
const TREE = '0f8fa5f3455e7905e4987603477e657291833b64';

test('recovery-terminal documentation records the exact completed live proof', () => {
  assert.match(calibration, /\*\*Status: completed live proof\.\*\*/);
  for (const value of [SOURCE, RECOVERY, MERGE, PROPOSAL, TREE]) {
    assert.match(calibration, new RegExp(value, 'g'));
  }
  for (const id of ['29454697392', '29454762852', '29454800587', '29454848877', '29454904814']) {
    assert.match(calibration, new RegExp(`https://github\\.com/fablebookjs/lab-01/actions/runs/${id}`));
  }
  assert.match(calibration, /https:\/\/github\.com\/fablebookjs\/lab-01\/pull\/25/);
  assert.match(calibration, /https:\/\/github\.com\/fablebookjs\/lab-01\/pull\/26/);
  assert.match(calibration, /https:\/\/github\.com\/fablebookjs\/lab-01\/pull\/27/);
  assert.equal(calibration.match(/`blocked-recovery-open`/g)?.length, 2);
  assert.match(calibration, /outcome `proposal-created`/);
  assert.match(calibration, /Outcome `proposal-reused`/);
  assert.match(calibration, /Proposal-Base: calibration\/g1\/recovery-terminal\/line/);
  assert.match(calibration, /Proposal-Version: 1\.0\.2/);
  assert.match(calibration, new RegExp(`Recovered-Line: ${MERGE}`));
  assert.match(calibration, new RegExp(`Recovery-Head: ${RECOVERY}`));
  assert.match(calibration, /exactly one commit and zero changed files/);
  assert.match(calibration, /There is no pending proof in this calibration/);
  assert.match(calibration, /remain exclusively owned by fablebookjs\/infra#19/);
  assert.doesNotMatch(calibration, /## Live operator sequence|gh workflow run|must report/);
});

test('public demo is a concise outcome-first screen-share with exact links and non-goals', () => {
  const links = [
    'https://fablebookjs.github.io/release-state-explorer/',
    'https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1',
    'https://www.npmjs.com/package/@fablebook/lab-01-core/v/1.0.1',
    'https://www.npmjs.com/package/@fablebook/lab-01-addon/v/1.0.1',
    'https://github.com/fablebookjs/lab-01/pull/44',
    'https://github.com/fablebookjs/lab-01/actions/runs/29487214563',
    'https://github.com/fablebookjs/lab-01/actions/runs/29488397580',
    'https://github.com/fablebookjs/lab-01/actions/runs/29489041168',
    'https://github.com/fablebookjs/lab-01/actions/runs/29489970777',
    'https://github.com/fablebookjs/lab-01/actions/runs/29490136244',
    'https://github.com/fablebookjs/lab-01/actions/runs/29490413923',
    'https://github.com/fablebookjs/lab-01/actions/runs/29490566032',
  ];
  for (const link of links) assert.ok(demo.includes(link), `missing demo link ${link}`);
  assert.match(demo, /## 60-second summary/);
  assert.match(demo, /## Five-minute click order/);
  assert.match(demo, /complete public `1\.0\.1` patch release/);
  assert.match(demo, /OIDC publication with a deliberate core-only pause/);
  assert.match(demo, /issued no duplicate POST/);
  assert.match(demo, /zero-file empty intent/);
  assert.match(demo, /does\s+not mutate Storybook/);
  assert.match(demo, /implement multi-major branch cuts/);
  assert.match(demo, /\[issue #19 live evidence\]\(issue-19-live-evidence\.md\)/);
  assert.ok(demo.split('\n').length < 130, 'demo should remain screen-share sized');
});

test('issue #19 evidence locks the public graph, packages, and convergence runs', () => {
  for (const sha of [
    'b59edf1d4c0fff51295327e8ce9e72678c336156',
    'c3061c74b52aea7b9ee47b99950f4fee13bce911',
    '30fb7cf66944462d56edf9d64198377a4b0d2f4c',
    'bc2c99750191ccdb14662c139ba9ea725d3a8a12',
    '5469d7a4d12abde629ba5384aaac2f0f19fb5b96',
    '0957e45dacfa3e4f6efedfeed6c338866553833d',
  ]) assert.match(publicReleaseEvidence, new RegExp(sha));
  for (const run of [
    '29487012788', '29487113659', '29487214563', '29488397580',
    '29489041168', '29489635435', '29489692288', '29489828068',
    '29489970777', '29490136244', '29490276054', '29490413923',
    '29490566032', '29490710157',
  ]) assert.match(publicReleaseEvidence, new RegExp(`/actions/runs/${run}`));
  assert.match(publicReleaseEvidence, /no invalid and no missing signatures/);
  assert.match(publicReleaseEvidence, /"invalid":\[\],"missing":\[\]/);
  assert.match(publicReleaseEvidence, /finalizer-attempts\/v1\.0\.1\/github-release/);
  assert.match(publicReleaseEvidence, /finalizer-attempts\/v1\.0\.2\/next-proposal/);
  assert.match(publicReleaseEvidence, /recovery\/v1\.0\/1\.0\.1` \| absent/);
  assert.match(publicReleaseEvidence, /issuecomment-4990036278/);
  assert.match(publicReleaseEvidence, /pull\/12/);
  assert.match(publicReleaseEvidence, /pull\/23/);
  assert.match(publicReleaseEvidence, /pull\/16/);
  assert.match(publicReleaseEvidence, /pull\/26/);
  assert.match(publicReleaseEvidence, /pull\/27/);
  assert.match(publicReleaseEvidence, /SLSA provenance/);
  assert.match(publicReleaseEvidence, /false for `X -> V` and true for `X -> J`/);
  assert.match(publicReleaseEvidence, /No controller in this proof has a Storybook/);
});

test('README surfaces the demo and changed Markdown is structurally clean', () => {
  const opening = readme.split('\n').slice(0, 12).join('\n');
  assert.match(opening, /\[five-minute screen-share script\]\(docs\/demo\.md\)/);
  assert.match(opening, /https:\/\/fablebookjs\.github\.io\/release-state-explorer\//);
  assert.match(finalizer, /ordinary merge `H=\[M,P\]`/);
  assert.doesNotMatch(finalizer, /Installation prerequisite|release-line candidate/);
  assert.doesNotMatch(readme, /Current staged QA is successful|release-line source candidate|this branch was/);
  assert.match(readme, /Exact `1\.0\.1` staged QA succeeded before M/);
  assert.match(readme, /current staged ref is the draft `1\.0\.2` intent/);
  assert.match(readme, /accepted\s+`1\.0\.1` source was exact `releases\/v1\.0` at `S`/);
  for (const [name, markdown] of [
    ['README', readme],
    ['calibration', calibration],
    ['demo', demo],
    ['finalizer', finalizer],
    ['public release evidence', publicReleaseEvidence],
  ]) {
    assert.doesNotMatch(markdown, /[ \t]+$/m, `${name} has trailing whitespace`);
    assert.equal(markdown.match(/^```/gm)?.length % 2 || 0, 0, `${name} has unbalanced fences`);
  }
  for (const match of demo.matchAll(/\]\(([^)]+\.md)\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(existsSync(new URL(`../docs/${match[1]}`, import.meta.url)), `missing local demo target ${match[1]}`);
  }
});
