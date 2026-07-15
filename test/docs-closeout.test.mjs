import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const calibration = readFileSync(
  new URL('../docs/recovery-terminal-calibration.md', import.meta.url),
  'utf8',
);
const demo = readFileSync(new URL('../docs/demo.md', import.meta.url), 'utf8');
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
    'https://github.com/fablebookjs/lab-01/pull/12',
    'https://github.com/fablebookjs/lab-01/pull/23',
    'https://github.com/fablebookjs/lab-01/pull/16',
    'https://github.com/fablebookjs/lab-01/pull/26',
    'https://github.com/fablebookjs/lab-01/pull/27',
    'https://github.com/fablebookjs/lab-01/actions/runs/29449854427',
    'https://github.com/fablebookjs/lab-01/actions/runs/29449963241',
    'https://github.com/fablebookjs/lab-01/actions/runs/29429579354',
    'https://github.com/fablebookjs/lab-01/actions/runs/29429674616',
    'https://github.com/fablebookjs/lab-01/actions/runs/29429754785',
    'https://github.com/fablebookjs/lab-01/actions/runs/29454762852',
    'https://github.com/fablebookjs/lab-01/actions/runs/29454800587',
    'https://github.com/fablebookjs/lab-01/actions/runs/29454848877',
    'https://github.com/fablebookjs/lab-01/actions/runs/29454904814',
    'https://github.com/fablebookjs/infra/blob/main/docs/evidence/lab-01-required-check-calibration.md',
  ];
  for (const link of links) assert.ok(demo.includes(link), `missing demo link ${link}`);
  assert.match(demo, /## 60-second summary/);
  assert.match(demo, /## Five-minute click order/);
  assert.match(demo, /The outcome is/);
  assert.match(demo, /simulated laboratory material/);
  assert.match(demo, /not the production controller/);
  assert.match(demo, /public package publication/);
  assert.match(demo, /integrated `M`\/`V` finalization, version tag, or GitHub Release creation/);
  assert.match(demo, /Storybook repository or package migration/);
  assert.match(demo, /commitment to multi-major release-line support/);
  assert.ok(demo.split('\n').length < 130, 'demo should remain screen-share sized');
});

test('README surfaces the demo and changed Markdown is structurally clean', () => {
  const opening = readme.split('\n').slice(0, 12).join('\n');
  assert.match(opening, /\[five-minute screen-share script\]\(docs\/demo\.md\)/);
  assert.match(opening, /https:\/\/fablebookjs\.github\.io\/release-state-explorer\//);
  for (const [name, markdown] of [['README', readme], ['calibration', calibration], ['demo', demo]]) {
    assert.doesNotMatch(markdown, /[ \t]+$/m, `${name} has trailing whitespace`);
    assert.equal(markdown.match(/^```/gm)?.length % 2 || 0, 0, `${name} has unbalanced fences`);
  }
  for (const match of demo.matchAll(/\]\(([^)]+\.md)\)/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(existsSync(new URL(`../docs/${match[1]}`, import.meta.url)), `missing local demo target ${match[1]}`);
  }
});
