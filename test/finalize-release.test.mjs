import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LiveGitHubAdapter,
  RECOVERY_REF,
  RELEASE_REF,
  STAGED_REF,
  TAG_REF,
  classifyNextAction,
  githubReleaseBody,
  observeMaintainerPostMerge,
  nextIntentMessage,
  nextProposalBody,
  observeDurableState,
  reconciliationMessage,
  runFinalizerInvocation,
} from '../scripts/finalize-release.mjs';
import {
  PACKAGE_SPECS,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  TRANSFORMED_FILES,
  buildSnapshotMessage,
} from '../scripts/release-publication.mjs';

const sha = (value) => value.repeat(40);
const ids = {
  source: sha('1'),
  intent: sha('2'),
  merge: sha('3'),
  snapshot: sha('4'),
  late: sha('5'),
  reconciliation: sha('6'),
  nextIntent: sha('7'),
  otherLate: sha('8'),
  main: sha('9'),
};
const trees = {
  source: sha('a'),
  snapshot: sha('b'),
  late: sha('c'),
  reconciliation: sha('d'),
  otherLate: sha('e'),
};
const expectedPackages = PACKAGE_SPECS.map((spec, index) => ({
  name: spec.name,
  integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}`,
  shasum: String(index + 1).repeat(40),
}));

function intentMessage(version = RELEASE_VERSION, source = ids.source) {
  return `release: propose v${version}\n\nRelease-Intent-Version: 1\nRelease-Line: releases/v1.0\nRelease-Version: ${version}\nRelease-Source: ${source}\n`;
}

function npmPresent(index, overrides = {}) {
  const spec = PACKAGE_SPECS[index];
  const expected = expectedPackages[index];
  return {
    status: 'present',
    name: spec.name,
    version: RELEASE_VERSION,
    repository: { type: 'git', url: REPOSITORY_URL, directory: spec.directory },
    dependencies: index === 1 ? { [PACKAGE_SPECS[0].name]: RELEASE_VERSION } : {},
    metadataIntegrity: expected.integrity,
    metadataShasum: expected.shasum,
    downloadedIntegrity: expected.integrity,
    downloadedShasum: expected.shasum,
    ...overrides,
  };
}

function releasePull() {
  return {
    number: 12,
    state: 'closed',
    draft: false,
    merged_at: '2026-07-16T00:00:00Z',
    merge_commit_sha: ids.merge,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/12',
    head: { ref: 'staged/v1.0', sha: ids.intent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.source, repo: { full_name: REPOSITORY } },
  };
}

class MemoryGit {
  constructor() {
    this.refs = {
      'refs/heads/main': { sha: ids.main, type: 'commit' },
      [SNAPSHOT_REF]: { sha: ids.snapshot, type: 'commit' },
      [RELEASE_REF]: { sha: ids.merge, type: 'commit' },
      [STAGED_REF]: { sha: ids.intent, type: 'commit' },
      'refs/heads/unrelated': { sha: ids.source, type: 'commit' },
      'refs/heads/calibration/g1/reconciliation/no-late/line': { sha: ids.otherLate, type: 'commit' },
    };
    this.commits = new Map([
      [ids.source, { sha: ids.source, parents: [sha('0')], tree: trees.source, message: 'fix: sealed source\n' }],
      [ids.intent, { sha: ids.intent, parents: [ids.source], tree: trees.source, message: intentMessage() }],
      [ids.merge, { sha: ids.merge, parents: [ids.source, ids.intent], tree: trees.source, message: 'Merge pull request #12\n' }],
      [ids.snapshot, {
        sha: ids.snapshot,
        parents: [ids.merge],
        tree: trees.snapshot,
        message: buildSnapshotMessage({ mergeSha: ids.merge, qaRunId: 29414043206, stagedSha: ids.intent, sourceSha: ids.source, packages: expectedPackages }),
      }],
      [ids.late, { sha: ids.late, parents: [ids.merge], tree: trees.late, message: 'fix(core): deliberately late finite guard\n' }],
      [ids.otherLate, { sha: ids.otherLate, parents: [ids.merge], tree: trees.otherLate, message: 'fix(core): concurrent late guard\n' }],
      [ids.reconciliation, {
        sha: ids.reconciliation,
        parents: [ids.late, ids.snapshot],
        tree: trees.reconciliation,
        message: reconciliationMessage({ mergeSha: ids.merge, lateSha: ids.late, snapshotSha: ids.snapshot }),
      }],
    ]);
    this.mergeTrees = new Map([
      [`${ids.late} ${ids.snapshot}`, { clean: true, tree: trees.reconciliation }],
      [`${ids.otherLate} ${ids.snapshot}`, { clean: true, tree: trees.reconciliation }],
      [`${ids.snapshot} ${ids.late}`, { clean: true, tree: trees.reconciliation }],
    ]);
    this.ancestors = new Set([
      `${ids.merge} ${ids.snapshot}`,
      `${ids.merge} ${ids.late}`,
      `${ids.merge} ${ids.otherLate}`,
      `${ids.late} ${ids.reconciliation}`,
      `${ids.snapshot} ${ids.reconciliation}`,
    ]);
    this.nextCommitShas = [];
    this.durableWrites = [];
    this.ambiguous = false;
    this.staleWinner = null;
  }

  async listRefs() { return structuredClone(this.refs); }
  async commit(value) {
    const commit = this.commits.get(value);
    if (!commit) throw new Error(`missing commit ${value}`);
    return structuredClone(commit);
  }
  async acceptedSnapshot(value) {
    assert.equal(value, ids.snapshot);
    return {
      schemaVersion: 1,
      locator: SNAPSHOT_REF,
      sourceSha: ids.source,
      stagedSha: ids.intent,
      mergeSha: ids.merge,
      source: await this.commit(ids.source),
      intent: await this.commit(ids.intent),
      merge: await this.commit(ids.merge),
      snapshot: await this.commit(ids.snapshot),
      packages: structuredClone(expectedPackages),
      qa: { kind: 'accepted-snapshot-proof', label: 'accepted-snapshot-proof:fixture' },
    };
  }
  async diffPaths(from, to) {
    assert.equal(from, ids.merge);
    assert.equal(to, ids.snapshot);
    return [...TRANSFORMED_FILES];
  }
  async jsonAt(_sha, path) {
    const spec = PACKAGE_SPECS.find((item) => path === `${item.directory}/package.json`);
    return {
      name: spec.name,
      version: RELEASE_VERSION,
      repository: { type: 'git', url: REPOSITORY_URL, directory: spec.directory },
      ...(spec.choice === 'addon' ? { dependencies: { [PACKAGE_SPECS[0].name]: RELEASE_VERSION } } : {}),
    };
  }
  async isAncestor(first, second) { return this.ancestors.has(`${first} ${second}`); }
  async mergeTree(first, second) {
    const value = this.mergeTrees.get(`${first} ${second}`);
    if (!value) throw new Error(`missing merge-tree ${first} ${second}`);
    return structuredClone(value);
  }
  async createCommit({ tree, parents, message }) {
    const value = this.nextCommitShas.shift();
    if (!value) throw new Error('no deterministic mock commit SHA');
    this.commits.set(value, { sha: value, tree, parents: [...parents], message });
    return value;
  }
  async pushRef(ref, expected, next) {
    this.durableWrites.push({ type: 'ref', ref, expected, next });
    if (this.staleWinner) {
      this.refs[ref] = { sha: this.staleWinner, type: 'commit' };
      this.staleWinner = null;
      throw new Error('stale lease');
    }
    assert.equal(this.refs[ref]?.sha ?? null, expected);
    this.refs[ref] = { sha: next, type: 'commit' };
    if (this.ambiguous) {
      this.ambiguous = false;
      throw new Error('lost ref success response');
    }
  }
}

class MemoryGitHub {
  constructor(gitAdapter) {
    this.git = gitAdapter;
    this.pulls = [releasePull(), {
      number: 99,
      state: 'open',
      draft: true,
      merged_at: null,
      merge_commit_sha: null,
      html_url: 'https://github.com/fablebookjs/lab-01/pull/99',
      head: { ref: 'calibration/g1/conflict-recovery/backup', sha: ids.otherLate, repo: { full_name: REPOSITORY } },
      base: { ref: 'calibration/g1/conflict-recovery/line', sha: ids.snapshot, repo: { full_name: REPOSITORY } },
      title: 'ignored calibration',
      body: 'ignored calibration',
    }];
    this.releases = [];
    this.durableWrites = [];
    this.ambiguousRelease = false;
    this.ambiguousPull = false;
  }
  async repository() { return { full_name: REPOSITORY, default_branch: 'main' }; }
  async listPulls() { return structuredClone(this.pulls); }
  async listReleases() { return structuredClone(this.releases); }
  async createRelease({ tagName, targetSha, body }) {
    this.durableWrites.push({ type: 'release', tagName, targetSha });
    this.releases.push({
      id: 501,
      tag_name: tagName,
      target_commitish: targetSha,
      name: tagName,
      body,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/fablebookjs/lab-01/releases/tag/${tagName}`,
    });
    if (this.ambiguousRelease) {
      this.ambiguousRelease = false;
      throw new Error('lost release POST response');
    }
  }
  async createPullRequest({ title, body, head, base, draft }) {
    this.durableWrites.push({ type: 'pull', head, base });
    this.pulls.push({
      number: 101,
      state: 'open',
      draft,
      merged_at: null,
      merge_commit_sha: null,
      title,
      body,
      html_url: 'https://github.com/fablebookjs/lab-01/pull/101',
      head: { ref: head, sha: this.git.refs[STAGED_REF].sha, repo: { full_name: REPOSITORY } },
      base: { ref: base, sha: this.git.refs[RELEASE_REF].sha, repo: { full_name: REPOSITORY } },
    });
    if (this.ambiguousPull) {
      this.ambiguousPull = false;
      throw new Error('lost PR POST response');
    }
  }
}

class MemoryNpm {
  constructor(observations = [npmPresent(0), npmPresent(1)]) {
    this.observations = observations;
    this.durableWrites = [];
  }
  async observe(spec) {
    return structuredClone(this.observations[PACKAGE_SPECS.findIndex((item) => item.name === spec.name)]);
  }
}

function fixture({ npm = [npmPresent(0), npmPresent(1)] } = {}) {
  const gitAdapter = new MemoryGit();
  const githubAdapter = new MemoryGitHub(gitAdapter);
  const npmAdapter = new MemoryNpm(npm);
  const context = {
    enforceTrustedMain: true,
    actor: 'ndelangen',
    triggeringActor: 'ndelangen',
    event: 'workflow_dispatch',
    runId: '700',
    sourceSha: ids.main,
    localSha: ids.main,
  };
  return { gitAdapter, githubAdapter, npmAdapter, context };
}

async function observe(value) {
  return observeDurableState({ ...value, context: value.context });
}

async function installExactRelease(value) {
  const state = await observe(value);
  value.githubAdapter.releases = [{
    id: 501,
    tag_name: 'v1.0.1',
    target_commitish: ids.snapshot,
    name: 'v1.0.1',
    body: githubReleaseBody(state),
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1',
  }];
}

function allWrites(value) {
  return [...value.gitAdapter.durableWrites, ...value.githubAdapter.durableWrites, ...value.npmAdapter.durableWrites];
}

test('workflow is exact trusted-main manual authority with no npm authentication surface', async () => {
  const workflow = await readFile(new URL('../.github/workflows/finalize-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /push:|pull_request:|schedule:/);
  assert.match(workflow, /group: finalize-v1\.0\.1\n  cancel-in-progress: false/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /permissions:\n      contents: write\n      pull-requests: write/);
  assert.doesNotMatch(workflow, /id-token:|packages:|actions: (?:read|write)|secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|npmrc|registry=/i);
  assert.doesNotMatch(workflow, /source_sha|merge_sha|snapshot_sha|head_sha|target_sha/i);
  for (const line of workflow.split('\n').filter((value) => value.trim().startsWith('uses:'))) {
    assert.match(line, /@[0-9a-f]{40}(?: # v6)?$/);
  }
  assert.deepEqual([...workflow.matchAll(/^\s{10}- (none|after-github-release-post)$/gm)].map((match) => match[1]), ['none', 'after-github-release-post']);
});

test('snapshot absence and the only canonical npm incomplete states are successful no-ops', async () => {
  const absentSnapshot = fixture({ npm: [{ status: 'absent', name: PACKAGE_SPECS[0].name }, { status: 'absent', name: PACKAGE_SPECS[1].name }] });
  delete absentSnapshot.gitAdapter.refs[SNAPSHOT_REF];
  assert.equal(classifyNextAction(await observe(absentSnapshot)).type, 'await-snapshot');

  const absent = fixture({ npm: [{ status: 'absent', name: PACKAGE_SPECS[0].name }, { status: 'absent', name: PACKAGE_SPECS[1].name }] });
  assert.deepEqual(classifyNextAction(await observe(absent)), { type: 'await-npm', durable: false, reason: 'packages-absent' });
  const partial = fixture({ npm: [npmPresent(0), { status: 'absent', name: PACKAGE_SPECS[1].name }] });
  assert.equal(classifyNextAction(await observe(partial)).reason, 'core-present-addon-absent');
  assert.deepEqual(allWrites(partial), []);
});

test('inverse, metadata, downloaded-byte, repository, and add-on dependency mismatches permanently stop', async () => {
  const cases = [
    [{ status: 'absent', name: PACKAGE_SPECS[0].name }, npmPresent(1)],
    [npmPresent(0, { metadataIntegrity: expectedPackages[1].integrity }), npmPresent(1)],
    [npmPresent(0, { downloadedShasum: 'f'.repeat(40) }), npmPresent(1)],
    [npmPresent(0, { repository: { type: 'git', url: 'git+https://github.com/other/repo.git', directory: 'packages/core' } }), npmPresent(1)],
    [npmPresent(0), npmPresent(1, { dependencies: { [PACKAGE_SPECS[0].name]: '1.0.0' } })],
  ];
  for (const npm of cases) await assert.rejects(observe(fixture({ npm })), /PERMANENT STOP/);
});

test('M fast-forwards to V with one exact lease and preserves unrelated refs and calibration PRs', async () => {
  const value = fixture();
  const unrelated = structuredClone(value.gitAdapter.refs['refs/heads/unrelated']);
  const calibration = structuredClone(value.githubAdapter.pulls[1]);
  const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(evidence.action.type, 'fast-forward-line');
  assert.equal(evidence.action.result, 'performed-and-verified');
  assert.deepEqual(value.gitAdapter.durableWrites, [{ type: 'ref', ref: RELEASE_REF, expected: ids.merge, next: ids.snapshot }]);
  assert.deepEqual(value.gitAdapter.refs['refs/heads/unrelated'], unrelated);
  assert.deepEqual(value.githubAdapter.pulls[1], calibration);
  assert.deepEqual(evidence.preservation.changedRefs, [{ name: RELEASE_REF, oldSha: ids.merge, newSha: ids.snapshot }]);
  assert.equal(evidence.preservation.storybookMutation, false);
  assert.equal(evidence.preservation.npmMutation, false);
});

test('one clean late X creates deterministic J [X,V], while a stale lease refetches a new valid H', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  value.gitAdapter.nextCommitShas.push(ids.reconciliation);
  const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(evidence.action.type, 'create-reconciliation');
  assert.equal(value.gitAdapter.refs[RELEASE_REF].sha, ids.reconciliation);
  assert.deepEqual(value.gitAdapter.commits.get(ids.reconciliation).parents, [ids.late, ids.snapshot]);
  assert.equal(value.gitAdapter.commits.get(ids.reconciliation).tree, trees.reconciliation);

  const stale = fixture();
  stale.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  stale.gitAdapter.nextCommitShas.push(ids.reconciliation);
  stale.gitAdapter.staleWinner = ids.otherLate;
  const staleEvidence = await runFinalizerInvocation({ adapters: stale, context: stale.context });
  assert.equal(staleEvidence.action.result, 'stale-ref-rejected-and-refetched');
  assert.equal(stale.gitAdapter.refs[RELEASE_REF].sha, ids.otherLate);
  assert.equal(stale.gitAdapter.durableWrites.length, 1);
});

test('real conflicts, reversed J, wrong tree, and multiple late segments fail closed before a write', async () => {
  const conflict = fixture();
  conflict.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  conflict.gitAdapter.mergeTrees.set(`${ids.late} ${ids.snapshot}`, { clean: false, tree: null });
  await assert.rejects(async () => classifyNextAction(await observe(conflict)), /REAL CONFLICT/);

  const reversed = fixture();
  reversed.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  reversed.gitAdapter.commits.get(ids.reconciliation).parents = [ids.snapshot, ids.late];
  await assert.rejects(observe(reversed), /not exact M, V/);

  const wrongTree = fixture();
  wrongTree.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  wrongTree.gitAdapter.commits.get(ids.reconciliation).tree = trees.otherLate;
  await assert.rejects(observe(wrongTree), /incompatible tree/);

  const multiple = fixture();
  multiple.gitAdapter.refs[RELEASE_REF].sha = ids.otherLate;
  multiple.gitAdapter.commits.get(ids.otherLate).parents = [ids.late];
  await assert.rejects(observe(multiple), /not exact M, V/);
  assert.deepEqual(allWrites(conflict), []);
});

test('tag is an expected-absent lightweight ref at V and incompatible tags permanently stop', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(evidence.action.type, 'create-tag');
  assert.deepEqual(value.gitAdapter.durableWrites, [{ type: 'ref', ref: TAG_REF, expected: null, next: ids.snapshot }]);

  const wrong = fixture();
  wrong.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  wrong.gitAdapter.refs[TAG_REF] = { sha: ids.merge, type: 'commit' };
  await assert.rejects(observe(wrong), /PERMANENT STOP/);
  const annotated = fixture();
  annotated.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  annotated.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'tag' };
  await assert.rejects(observe(annotated), /lightweight/);
});

test('lost GitHub Release success and the retained injected fault converge without duplicate POST', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  value.githubAdapter.ambiguousRelease = true;
  await assert.rejects(
    runFinalizerInvocation({ adapters: value, context: value.context, fault: 'after-github-release-post' }),
    /INJECTED FAULT/,
  );
  assert.equal(value.githubAdapter.durableWrites.length, 1);
  assert.equal(value.githubAdapter.releases.length, 1);
  const rerun = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(rerun.action.type, 'complete');
  assert.equal(value.githubAdapter.durableWrites.length, 1);

  value.githubAdapter.releases[0].draft = true;
  await assert.rejects(observe(value), /incompatible/);
});

test('an exact open recovery PR may coexist with tag and Release but suppresses the next proposal', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  value.gitAdapter.refs[RECOVERY_REF] = { sha: ids.late, type: 'commit' };
  value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  value.gitAdapter.mergeTrees.set(`${ids.late} ${ids.snapshot}`, { clean: false, tree: null });
  value.githubAdapter.pulls.push({
    number: 100,
    state: 'open',
    draft: true,
    merged_at: null,
    merge_commit_sha: null,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/100',
    title: 'Recover late work',
    body: 'Recorded issue #15 recovery',
    head: { ref: 'recovery/v1.0/1.0.1', sha: ids.late, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.snapshot, repo: { full_name: REPOSITORY } },
  });
  await installExactRelease(value);
  const state = await observe(value);
  assert.equal(classifyNextAction(state).type, 'wait-recovery');
  assert.equal(state.recovery.pull.number, 100);
  assert.deepEqual(allWrites(value), []);
});

test('normal J advances the old staged intent, then creates exactly one draft with lost-success convergence', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(value);
  value.gitAdapter.nextCommitShas.push(ids.nextIntent);
  value.gitAdapter.ambiguous = true;
  const intentRun = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(intentRun.action.type, 'advance-staged-intent');
  assert.equal(intentRun.action.result, 'converged-after-ambiguous-response');
  const next = value.gitAdapter.commits.get(ids.nextIntent);
  assert.deepEqual(next.parents, [ids.reconciliation]);
  assert.equal(next.tree, trees.reconciliation);
  assert.equal(next.message, nextIntentMessage(ids.reconciliation));

  value.githubAdapter.ambiguousPull = true;
  const prRun = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(prRun.action.type, 'create-next-proposal');
  assert.equal(prRun.action.result, 'converged-after-ambiguous-response');
  assert.equal(value.githubAdapter.durableWrites.filter(({ type }) => type === 'pull').length, 1);
  assert.match(value.githubAdapter.pulls.at(-1).body, new RegExp(ids.late));
  assert.match(value.githubAdapter.pulls.at(-1).body, /Mark this draft ready/);
  assert.match(value.githubAdapter.pulls.at(-1).body, /Close an unmerged proposal/);

  const rerun = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(rerun.action.type, 'maintain-next-proposal');
  assert.equal(value.githubAdapter.durableWrites.filter(({ type }) => type === 'pull').length, 1);
  assert.equal(nextProposalBody(await observe(value)), value.githubAdapter.pulls.at(-1).body);
});

test('closed next proposals regenerate once, while duplicates and merged/wrong identities stop', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(value);
  value.gitAdapter.refs[STAGED_REF].sha = ids.nextIntent;
  value.gitAdapter.commits.set(ids.nextIntent, { sha: ids.nextIntent, parents: [ids.reconciliation], tree: trees.reconciliation, message: nextIntentMessage(ids.reconciliation) });
  const state = await observe(value);
  const body = nextProposalBody(state);
  value.githubAdapter.pulls.push({
    number: 100,
    state: 'closed',
    draft: true,
    merged_at: null,
    merge_commit_sha: null,
    title: 'release: propose v1.0.2',
    body,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/100',
    head: { ref: 'staged/v1.0', sha: ids.nextIntent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.reconciliation, repo: { full_name: REPOSITORY } },
  });
  assert.equal(classifyNextAction(await observe(value)).type, 'create-next-proposal');

  const duplicate = fixture();
  duplicate.githubAdapter.pulls.push(structuredClone(duplicate.githubAdapter.pulls[0]));
  await assert.rejects(observe(duplicate), /duplicate pull request number/);

  value.githubAdapter.pulls.at(-1).state = 'open';
  value.githubAdapter.pulls.push({ ...structuredClone(value.githubAdapter.pulls.at(-1)), number: 102 });
  await assert.rejects(observe(value), /more than one open/);
});

test('complete pagination is bounded, ordered, and rejects duplicate page identities', async () => {
  const adapter = new LiveGitHubAdapter();
  const values = Array.from({ length: 205 }, (_, index) => ({ number: index + 1 }));
  adapter.request = async (_method, path) => {
    const page = Number(new URL(`https://example.invalid${path}`).searchParams.get('page'));
    return { value: values.slice((page - 1) * 100, page * 100) };
  };
  assert.equal((await adapter.paginate('/pulls?state=all')).length, 205);

  const endless = new LiveGitHubAdapter();
  endless.request = async (_method, path) => {
    const page = Number(new URL(`https://example.invalid${path}`).searchParams.get('page'));
    return { value: Array.from({ length: 100 }, (_, index) => ({ number: (page - 1) * 100 + index + 1 })) };
  };
  await assert.rejects(endless.paginate('/pulls?state=all'), /exceeded/);
});

test('wake-up ordering converges with no invocation performing more than one durable write', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  value.gitAdapter.nextCommitShas.push(ids.reconciliation, ids.nextIntent);
  const actions = [];
  for (let index = 0; index < 7; index += 1) {
    const before = allWrites(value).length;
    const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
    actions.push(evidence.action.type);
    const writes = allWrites(value).length - before;
    assert.ok(writes <= 1, `${evidence.action.type} performed ${writes} durable writes`);
  }
  assert.deepEqual(actions, [
    'create-reconciliation',
    'create-tag',
    'create-github-release',
    'advance-staged-intent',
    'create-next-proposal',
    'maintain-next-proposal',
    'maintain-next-proposal',
  ]);
});

test('pure maintainer observer derives H and deterministic normal J markers from durable Git facts', async () => {
  const late = fixture();
  late.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  assert.deepEqual(await observeMaintainerPostMerge({
    gitAdapter: late.gitAdapter,
    releaseHeadSha: ids.late,
    mergeSha: ids.merge,
    snapshotSha: ids.snapshot,
  }), {
    observer: 'issue-19-finalizer',
    schemaVersion: 1,
    line: 'releases/v1.0',
    version: '1.0.1',
    mergeSha: ids.merge,
    headSha: ids.late,
    snapshotSha: ids.snapshot,
    kind: 'late-head',
    verifiedMergeSha: ids.merge,
  });

  const normal = fixture();
  normal.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  assert.deepEqual(await observeMaintainerPostMerge({
    gitAdapter: normal.gitAdapter,
    releaseHeadSha: ids.reconciliation,
    mergeSha: ids.merge,
    snapshotSha: ids.snapshot,
  }), {
    observer: 'issue-19-finalizer',
    schemaVersion: 1,
    line: 'releases/v1.0',
    version: '1.0.1',
    mergeSha: ids.merge,
    headSha: ids.reconciliation,
    snapshotSha: ids.snapshot,
    kind: 'normal-reconciliation',
    lateHeadSha: ids.late,
    expectedTreeSha: trees.reconciliation,
    metadata: {
      schemaVersion: 1,
      line: 'releases/v1.0',
      version: '1.0.1',
      mergeSha: ids.merge,
      snapshotSha: ids.snapshot,
      lateHeadSha: ids.late,
    },
  });

  normal.gitAdapter.commits.get(ids.reconciliation).message = 'self-attested but wrong\n';
  await assert.rejects(observeMaintainerPostMerge({
    gitAdapter: normal.gitAdapter,
    releaseHeadSha: ids.reconciliation,
    mergeSha: ids.merge,
    snapshotSha: ids.snapshot,
  }), /structured reconciliation metadata/);
});
