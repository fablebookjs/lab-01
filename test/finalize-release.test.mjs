import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DefiniteGitHubClientError,
  LiveGitAdapter,
  LiveGitHubAdapter,
  LiveNpmAdapter,
  PROPOSAL_ATTEMPT_REF,
  RECOVERY_REF,
  RELEASE_ATTEMPT_REF,
  RELEASE_REF,
  StaleLeaseError,
  STAGED_REF,
  TAG_REF,
  buildLeasedPushArguments,
  classifyNextAction,
  githubReleaseBody,
  observeMaintainerPostMerge,
  nextIntentMessage,
  nextProposalBody,
  observeDurableState,
  reconciliationMessage,
  recoveryPullBody,
  recoveryPullTitle,
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
  oldIntent: sha('a'),
  recoveryReconciliation: sha('f'),
};
const trees = {
  source: sha('a'),
  snapshot: sha('b'),
  late: sha('c'),
  reconciliation: sha('d'),
  otherLate: sha('e'),
  recovery: sha('0'),
};
const expectedPackages = PACKAGE_SPECS.map((spec, index) => ({
  name: spec.name,
  integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}`,
  shasum: String(index + 1).repeat(40),
}));
const snapshotContentSha256 = 'a'.repeat(64);

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
    id: 1200,
    number: 12,
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-07-16T00:00:00Z',
    merge_commit_sha: ids.merge,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/12',
    title: 'release: propose v1.0.1',
    body: 'sealed release proposal',
    head: { ref: 'staged/v1.0', sha: ids.intent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.source, repo: { full_name: REPOSITORY } },
  };
}

function recoveryPull(overrides = {}) {
  return {
    id: 10000,
    number: 100,
    state: 'open',
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/100',
    title: recoveryPullTitle(),
    body: recoveryPullBody({ lateSha: ids.late, snapshotSha: ids.snapshot }),
    head: { ref: 'recovery/v1.0/1.0.1', sha: ids.late, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.snapshot, repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

function historicalReleasePull(number = 1, overrides = {}) {
  return {
    id: 10000 + number,
    number,
    state: 'closed',
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    html_url: `https://github.com/fablebookjs/lab-01/pull/${number}`,
    title: 'Release 1.0.1',
    body: 'Arbitrarily edited presentation; the structured empty commit remains authoritative.',
    head: { ref: 'staged/v1.0', sha: ids.oldIntent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.source, repo: { full_name: REPOSITORY } },
    ...overrides,
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
      [ids.oldIntent, { sha: ids.oldIntent, parents: [ids.source], tree: trees.source, message: intentMessage() }],
      [ids.merge, { sha: ids.merge, parents: [ids.source, ids.intent], tree: trees.source, message: 'Merge pull request #12\n' }],
      [ids.snapshot, {
        sha: ids.snapshot,
        parents: [ids.merge],
        tree: trees.snapshot,
        message: buildSnapshotMessage({
          mergeSha: ids.merge,
          stagedSha: ids.intent,
          sourceSha: ids.source,
          tree: trees.snapshot,
          contentSha256: snapshotContentSha256,
          packages: expectedPackages,
        }),
      }],
      [ids.late, { sha: ids.late, parents: [ids.merge], tree: trees.late, message: 'fix(core): deliberately late finite guard\n' }],
      [ids.otherLate, { sha: ids.otherLate, parents: [ids.merge], tree: trees.otherLate, message: 'fix(core): concurrent late guard\n' }],
      [ids.reconciliation, {
        sha: ids.reconciliation,
        parents: [ids.late, ids.snapshot],
        tree: trees.reconciliation,
        message: reconciliationMessage({ mergeSha: ids.merge, lateSha: ids.late, snapshotSha: ids.snapshot }),
      }],
      [ids.recoveryReconciliation, {
        sha: ids.recoveryReconciliation,
        parents: [ids.snapshot, ids.late],
        tree: trees.recovery,
        message: 'Merge pull request #100 from fablebookjs/recovery/v1.0/1.0.1\n',
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
      `${ids.snapshot} ${ids.recoveryReconciliation}`,
      `${ids.late} ${ids.recoveryReconciliation}`,
    ]);
    this.nextCommitShas = [];
    this.durableWrites = [];
    this.operations = [];
    this.ambiguous = false;
    this.staleWinner = null;
    this.genericPushFailure = false;
    this.mainCheckHook = null;
    this.refReadHook = null;
    this.stableRefReadHook = null;
  }

  async listRefs() {
    this.operations.push({ transport: 'git', method: 'ls-remote', mutation: false, repository: REPOSITORY });
    if (this.refReadHook) await this.refReadHook(this);
    return structuredClone(this.refs);
  }
  async readStableRef(ref) {
    this.operations.push({ transport: 'git', method: 'ls-remote', mutation: false, repository: REPOSITORY, ref });
    if (this.stableRefReadHook) await this.stableRefReadHook(this, ref);
    return this.refs[ref]?.sha ?? null;
  }
  async preflight() {}
  async assertTrustedMain(context, knownRefs = null) {
    if (this.mainCheckHook) await this.mainCheckHook(this, knownRefs);
    const remoteMainSha = this.refs['refs/heads/main']?.sha ?? null;
    if (
      remoteMainSha !== context.sourceSha ||
      context.localSha !== context.sourceSha ||
      context.workflowSha !== context.sourceSha
    ) throw new Error('trusted current-main binding drifted before mutation');
    return { remoteMainSha, localSha: context.localSha, sourceSha: context.sourceSha, workflowSha: context.workflowSha };
  }
  async commit(value) {
    const commit = this.commits.get(value);
    if (!commit) throw new Error(`missing commit ${value}`);
    return structuredClone(commit);
  }
  async pullCommit(_number, value) { return this.commit(value); }
  async acceptedSnapshot(value) {
    assert.equal(value, ids.snapshot);
    return {
      schemaVersion: 2,
      locator: SNAPSHOT_REF,
      sourceSha: ids.source,
      stagedSha: ids.intent,
      mergeSha: ids.merge,
      source: await this.commit(ids.source),
      intent: await this.commit(ids.intent),
      merge: await this.commit(ids.merge),
      snapshot: await this.commit(ids.snapshot),
      treeSha: trees.snapshot,
      contentSha256: snapshotContentSha256,
      packages: structuredClone(expectedPackages),
      qa: {
        kind: 'accepted-snapshot-content',
        treeSha: trees.snapshot,
        contentSha256: snapshotContentSha256,
        label: `accepted-snapshot-content:${trees.snapshot}:${snapshotContentSha256}`,
      },
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
  async pushRef(ref, expected, next, { context } = {}) {
    if (context) await this.assertTrustedMain(context);
    this.durableWrites.push({ type: 'ref', ref, expected, next });
    this.operations.push({ transport: 'git', method: 'push', mutation: true, repository: REPOSITORY, ref, expected, next });
    if (this.genericPushFailure) {
      this.genericPushFailure = false;
      throw new Error('authentication or transport failure');
    }
    if (this.staleWinner) {
      this.refs[ref] = { sha: this.staleWinner, type: 'commit' };
      this.staleWinner = null;
      throw new StaleLeaseError(ref);
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
      id: 9900,
      number: 99,
      state: 'open',
      draft: true,
      merged: false,
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
    this.operations = [];
    this.ambiguousRelease = false;
    this.ambiguousPull = false;
    this.releaseVisibilityDelay = 0;
    this.pullVisibilityDelay = 0;
    this.pendingReleases = [];
    this.pendingPulls = [];
    this.definiteReleaseRejection = false;
    this.definitePullRejection = false;
    this.pullReadHook = null;
    this.beforeReleaseCreate = null;
    this.beforePullCreate = null;
  }
  async repository() {
    this.operations.push({ transport: 'github', method: 'GET', mutation: false, repository: REPOSITORY, endpoint: '/' });
    return { full_name: REPOSITORY, default_branch: 'main' };
  }
  async listPulls() {
    this.operations.push({ transport: 'github', method: 'GET', mutation: false, repository: REPOSITORY, endpoint: '/pulls' });
    if (this.pullVisibilityDelay > 0) this.pullVisibilityDelay -= 1;
    else if (this.pendingPulls.length) this.pulls.push(...this.pendingPulls.splice(0));
    if (this.pullReadHook) await this.pullReadHook(this);
    return structuredClone(this.pulls.map((pull) => ({ ...pull, id: pull.id ?? 10000 + pull.number })));
  }
  async listReleases() {
    this.operations.push({ transport: 'github', method: 'GET', mutation: false, repository: REPOSITORY, endpoint: '/releases' });
    if (this.releaseVisibilityDelay > 0) this.releaseVisibilityDelay -= 1;
    else if (this.pendingReleases.length) this.releases.push(...this.pendingReleases.splice(0));
    return structuredClone(this.releases);
  }
  async createRelease({ tagName, targetSha, body, expectedLineSha, expectedTagSha }) {
    if (this.beforeReleaseCreate) await this.beforeReleaseCreate(this);
    this.durableWrites.push({ type: 'release', tagName, targetSha });
    this.operations.push({
      transport: 'github', method: 'POST', mutation: true, repository: REPOSITORY, endpoint: '/releases',
      expectations: { targetSha, expectedLineSha, expectedTagSha },
    });
    if (this.definiteReleaseRejection) {
      this.definiteReleaseRejection = false;
      throw new DefiniteGitHubClientError(400, '/releases');
    }
    const release = {
      id: 501,
      tag_name: tagName,
      target_commitish: targetSha,
      name: tagName,
      body,
      draft: false,
      prerelease: false,
      html_url: `https://github.com/fablebookjs/lab-01/releases/tag/${tagName}`,
    };
    if (this.releaseVisibilityDelay > 0) this.pendingReleases.push(release);
    else this.releases.push(release);
    if (this.ambiguousRelease) {
      this.ambiguousRelease = false;
      throw new Error('lost release POST response');
    }
    return structuredClone(release);
  }
  async createPullRequest({ title, body, head, base, draft, expectedHeadSha, expectedBaseSha }) {
    if (this.beforePullCreate) await this.beforePullCreate(this);
    this.durableWrites.push({ type: 'pull', head, base });
    this.operations.push({
      transport: 'github', method: 'POST', mutation: true, repository: REPOSITORY, endpoint: '/pulls',
      expectations: { expectedHeadSha, expectedBaseSha },
    });
    if (this.definitePullRejection) {
      this.definitePullRejection = false;
      throw new DefiniteGitHubClientError(400, '/pulls');
    }
    const pull = {
      id: 10100,
      number: 101,
      state: 'open',
      draft,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      title,
      body,
      html_url: 'https://github.com/fablebookjs/lab-01/pull/101',
      head: { ref: head, sha: this.git.refs[STAGED_REF].sha, repo: { full_name: REPOSITORY } },
      base: { ref: base, sha: this.git.refs[RELEASE_REF].sha, repo: { full_name: REPOSITORY } },
    };
    if (this.pullVisibilityDelay > 0) this.pendingPulls.push(pull);
    else this.pulls.push(pull);
    if (this.ambiguousPull) {
      this.ambiguousPull = false;
      throw new Error('lost PR POST response');
    }
    return structuredClone(pull);
  }
}

class MemoryNpm {
  constructor(observations = [npmPresent(0), npmPresent(1)]) {
    this.observations = observations;
    this.durableWrites = [];
    this.operations = [];
  }
  async observe(spec) {
    this.operations.push({ transport: 'npm', method: 'GET', mutation: false, package: spec.name, resource: 'metadata+tarball' });
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
    workflowSha: ids.main,
    localSha: ids.main,
  };
  return { gitAdapter, githubAdapter, npmAdapter, context };
}

async function observe(value) {
  return observeDurableState({ ...value, context: value.context });
}

async function installExactRelease(value) {
  value.gitAdapter.refs[RELEASE_ATTEMPT_REF] = { sha: ids.snapshot, type: 'commit' };
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
  assert.ok(workflow.indexOf('node scripts/bootstrap-npm-cli.mjs') < workflow.indexOf('node scripts/finalize-release.mjs'));
  assert.doesNotMatch(workflow, /npm\s+(?:publish|login|adduser|token)/i);
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

test('acceptedSnapshot authority is schema-2 tree/content bound with no QA run identity', async () => {
  const value = fixture();
  const state = await observe(value);
  assert.equal(state.graph.authority.schemaVersion, 2);
  assert.equal(state.graph.authority.treeSha, trees.snapshot);
  assert.equal(state.graph.authority.contentSha256, snapshotContentSha256);
  assert.deepEqual(state.graph.authority.qa, {
    kind: 'accepted-snapshot-content',
    treeSha: trees.snapshot,
    contentSha256: snapshotContentSha256,
    label: `accepted-snapshot-content:${trees.snapshot}:${snapshotContentSha256}`,
  });
  assert.doesNotMatch(value.gitAdapter.commits.get(ids.snapshot).message, /Release-QA-Run/);
  assert.match(value.gitAdapter.commits.get(ids.snapshot).message, new RegExp(`Release-Tree: ${trees.snapshot}`));
  assert.match(value.gitAdapter.commits.get(ids.snapshot).message, new RegExp(`Release-Content-SHA256: ${snapshotContentSha256}`));

  const incompatible = fixture();
  const acceptedSnapshot = incompatible.gitAdapter.acceptedSnapshot.bind(incompatible.gitAdapter);
  incompatible.gitAdapter.acceptedSnapshot = async (shaValue) => ({
    ...(await acceptedSnapshot(shaValue)),
    contentSha256: 'b'.repeat(64),
  });
  await assert.rejects(observe(incompatible), /incomplete or incompatible authority record/);
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
  assert.equal(evidence.preservation.assessment.allGitWritesAllowlisted, true);
  assert.equal(evidence.preservation.assessment.npmTransportReadOnly, true);
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
  const authorization = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(authorization.action.type, 'authorize-github-release');
  value.githubAdapter.ambiguousRelease = true;
  await assert.rejects(
    runFinalizerInvocation({ adapters: value, context: value.context, fault: 'after-github-release-post' }),
    /INJECTED FAULT/,
  );
  assert.equal(value.githubAdapter.durableWrites.length, 1);
  assert.equal(value.githubAdapter.releases.length, 1);
  assert.deepEqual(
    value.githubAdapter.operations.find(({ method }) => method === 'POST').expectations,
    { targetSha: ids.snapshot, expectedLineSha: ids.snapshot, expectedTagSha: ids.snapshot },
  );
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
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/100',
    title: recoveryPullTitle(),
    body: recoveryPullBody({ lateSha: ids.late, snapshotSha: ids.snapshot }),
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
  const authorizePr = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(authorizePr.action.type, 'authorize-next-proposal');
  value.githubAdapter.ambiguousPull = true;
  const prRun = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(prRun.action.type, 'post-next-proposal');
  assert.equal(prRun.action.result, 'converged-after-ambiguous-response');
  assert.equal(value.githubAdapter.durableWrites.filter(({ type }) => type === 'pull').length, 1);
  assert.deepEqual(
    value.githubAdapter.operations.find(({ method, endpoint }) => method === 'POST' && endpoint === '/pulls').expectations,
    { expectedHeadSha: ids.nextIntent, expectedBaseSha: ids.reconciliation },
  );
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
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    title: 'release: propose v1.0.2',
    body,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/100',
    head: { ref: 'staged/v1.0', sha: ids.nextIntent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.reconciliation, repo: { full_name: REPOSITORY } },
  });
  value.gitAdapter.refs[PROPOSAL_ATTEMPT_REF] = { sha: ids.nextIntent, type: 'commit' };
  assert.equal(classifyNextAction(await observe(value)).type, 'reauthorize-next-proposal-after-close');

  value.githubAdapter.pulls.at(-1).draft = false;
  assert.equal(classifyNextAction(await observe(value)).type, 'reauthorize-next-proposal-after-close');
  value.githubAdapter.pulls.at(-1).draft = true;

  const duplicate = fixture();
  duplicate.githubAdapter.pulls.push(structuredClone(duplicate.githubAdapter.pulls[0]));
  await assert.rejects(observe(duplicate), /duplicate pull request number/);

  value.githubAdapter.pulls.at(-1).state = 'open';
  value.githubAdapter.pulls.push({
    ...structuredClone(value.githubAdapter.pulls.at(-1)),
    number: 102,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/102',
  });
  await assert.rejects(observe(value), /more than one open/);
});

test('retained live-shaped 1.0.1 lifecycle history is classified and preserved around 1.0.2 staging', async () => {
  const before = fixture();
  before.githubAdapter.pulls.push(historicalReleasePull(1), historicalReleasePull(11));
  const beforeState = await observe(before);
  assert.deepEqual(beforeState.historicalReleasePulls.map(({ number }) => number), [1, 11]);
  assert.equal(classifyNextAction(beforeState).type, 'fast-forward-line');

  const after = fixture();
  after.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  after.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(after);
  after.gitAdapter.refs[STAGED_REF].sha = ids.nextIntent;
  after.gitAdapter.commits.set(ids.nextIntent, {
    sha: ids.nextIntent,
    parents: [ids.reconciliation],
    tree: trees.reconciliation,
    message: nextIntentMessage(ids.reconciliation),
  });
  after.githubAdapter.pulls.splice(1, 0, historicalReleasePull(1));
  after.githubAdapter.pulls.push(historicalReleasePull(11));
  const afterState = await observe(after);
  assert.deepEqual(afterState.historicalReleasePulls.map(({ number }) => number), [1, 11]);
  assert.equal(classifyNextAction(afterState).type, 'authorize-next-proposal');

  after.gitAdapter.commits.get(ids.oldIntent).message = intentMessage(RELEASE_VERSION, ids.otherLate);
  await assert.rejects(observe(after), /invalid Release-Source/);
});

test('complete pagination is bounded, ordered, and rejects duplicate page identities', async () => {
  const adapter = new LiveGitHubAdapter();
  const values = Array.from({ length: 205 }, (_, index) => ({ id: 1000 + index, number: index + 1 }));
  adapter.request = async (_method, path) => {
    const page = Number(new URL(`https://example.invalid${path}`).searchParams.get('page'));
    return values.slice((page - 1) * 100, page * 100);
  };
  assert.equal((await adapter.paginate(`/repos/${REPOSITORY}/pulls?state=all`)).length, 205);

  const endless = new LiveGitHubAdapter();
  endless.request = async (_method, path) => {
    const page = Number(new URL(`https://example.invalid${path}`).searchParams.get('page'));
    return Array.from({ length: 100 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1000,
      number: (page - 1) * 100 + index + 1,
    }));
  };
  await assert.rejects(endless.paginate(`/repos/${REPOSITORY}/pulls?state=all`), /exceeded/);
});

test('Release pagination structurally routes zero, one, multi-page, query, and ceiling sweeps', async () => {
  const release = (id) => ({
    id,
    tag_name: `v1.0.${id}`,
    target_commitish: ids.snapshot,
    name: `v1.0.${id}`,
    body: `release ${id}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/fablebookjs/lab-01/releases/tag/v1.0.${id}`,
  });

  const zero = new LiveGitHubAdapter();
  const zeroRequests = [];
  zero.request = async (_method, path) => { zeroRequests.push(path); return []; };
  assert.deepEqual(await zero.releaseSweep(), []);
  assert.deepEqual(zeroRequests, [`/repos/${REPOSITORY}/releases?per_page=100&page=1`]);

  const one = new LiveGitHubAdapter();
  const oneRequests = [];
  one.request = async (_method, path) => {
    oneRequests.push(path);
    return path.includes('/releases?') ? [{ id: 501 }] : release(501);
  };
  assert.deepEqual((await one.releaseSweep()).map(({ id }) => id), [501]);
  assert.equal(oneRequests.length, 2);

  const multi = new LiveGitHubAdapter();
  const multiRequests = [];
  multi.request = async (_method, path) => {
    multiRequests.push(path);
    if (!path.includes('/releases?')) return release(Number(path.split('/').at(-1)));
    const page = Number(new URL(`https://api.github.invalid${path}`).searchParams.get('page'));
    if (page === 1) return Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    return [{ id: 101 }];
  };
  assert.equal((await multi.releaseSweep()).length, 101);
  assert.equal(multiRequests.filter((path) => path.includes('/releases?')).length, 2);
  assert.equal(multiRequests.length, 103);

  const withQuery = new LiveGitHubAdapter();
  const queryRequests = [];
  withQuery.request = async (_method, path) => { queryRequests.push(path); return []; };
  await withQuery.paginate(`/repos/${REPOSITORY}/releases?per_page=1`);
  assert.deepEqual(queryRequests, [`/repos/${REPOSITORY}/releases?per_page=100&page=1`]);

  const ceiling = new LiveGitHubAdapter();
  let ceilingRequests = 0;
  ceiling.request = async () => {
    ceilingRequests += 1;
    return Array.from({ length: 100 }, (_, index) => ({ id: (ceilingRequests - 1) * 100 + index + 1 }));
  };
  await assert.rejects(ceiling.paginate(`/repos/${REPOSITORY}/releases`), /exceeded/);
  assert.equal(ceilingRequests, 100);
});

test('wake-up ordering converges with one classified action and at most one GitHub POST', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  value.gitAdapter.nextCommitShas.push(ids.reconciliation, ids.nextIntent);
  const actions = [];
  for (let index = 0; index < 10; index += 1) {
    const before = allWrites(value).length;
    const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
    actions.push(evidence.action.type);
    const writes = allWrites(value).length - before;
    const posts = evidence.preservation.operations.filter((operation) => operation.method === 'POST').length;
    assert.ok(posts <= 1, `${evidence.action.type} performed ${posts} GitHub POSTs`);
    assert.ok(writes <= 2, `${evidence.action.type} escaped its bounded action protocol with ${writes} writes`);
  }
  assert.deepEqual(actions, [
    'create-reconciliation',
    'create-tag',
    'authorize-github-release',
    'post-github-release',
    'advance-staged-intent',
    'authorize-next-proposal',
    'post-next-proposal',
    'maintain-next-proposal',
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

  const patchSha = sha('b');
  const mergedLateSha = sha('c');
  const mergedLate = fixture();
  mergedLate.gitAdapter.commits.set(patchSha, {
    sha: patchSha,
    parents: [ids.merge],
    tree: trees.late,
    message: 'fix: ordinary late patch\n',
  });
  mergedLate.gitAdapter.commits.set(mergedLateSha, {
    sha: mergedLateSha,
    parents: [ids.merge, patchSha],
    tree: trees.late,
    message: 'Merge pull request #37\n',
  });
  mergedLate.gitAdapter.refs[RELEASE_REF].sha = mergedLateSha;
  mergedLate.gitAdapter.mergeTrees.set(
    `${mergedLateSha} ${ids.snapshot}`,
    { clean: true, tree: trees.reconciliation },
  );
  assert.equal(
    (await observeMaintainerPostMerge({ gitAdapter: mergedLate.gitAdapter })).headSha,
    mergedLateSha,
  );

  for (const mutate of [
    (value) => { value.gitAdapter.commits.get(patchSha).parents = [ids.source]; },
    (value) => { value.gitAdapter.commits.get(mergedLateSha).tree = trees.otherLate; },
  ]) {
    const malformed = fixture();
    malformed.gitAdapter.commits.set(
      patchSha,
      structuredClone(mergedLate.gitAdapter.commits.get(patchSha)),
    );
    malformed.gitAdapter.commits.set(
      mergedLateSha,
      structuredClone(mergedLate.gitAdapter.commits.get(mergedLateSha)),
    );
    malformed.gitAdapter.refs[RELEASE_REF].sha = mergedLateSha;
    malformed.gitAdapter.mergeTrees.set(
      `${mergedLateSha} ${ids.snapshot}`,
      { clean: true, tree: trees.reconciliation },
    );
    mutate(malformed);
    await assert.rejects(
      observeMaintainerPostMerge({ gitAdapter: malformed.gitAdapter }),
      /ordinary late merge/,
    );
  }

  const reconciledMergedLate = fixture();
  reconciledMergedLate.gitAdapter.commits.set(patchSha, mergedLate.gitAdapter.commits.get(patchSha));
  reconciledMergedLate.gitAdapter.commits.set(
    mergedLateSha,
    mergedLate.gitAdapter.commits.get(mergedLateSha),
  );
  reconciledMergedLate.gitAdapter.commits.get(ids.reconciliation).parents = [
    mergedLateSha,
    ids.snapshot,
  ];
  reconciledMergedLate.gitAdapter.commits.get(ids.reconciliation).message = reconciliationMessage({
    mergeSha: ids.merge,
    lateSha: mergedLateSha,
    snapshotSha: ids.snapshot,
  });
  reconciledMergedLate.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  reconciledMergedLate.gitAdapter.mergeTrees.set(
    `${mergedLateSha} ${ids.snapshot}`,
    { clean: true, tree: trees.reconciliation },
  );
  assert.equal(
    (await observeMaintainerPostMerge({ gitAdapter: reconciledMergedLate.gitAdapter })).lateHeadSha,
    mergedLateSha,
  );

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

test('maintainer observer treats caller SHAs only as expectations and rejects ref drift', async () => {
  const offRef = fixture();
  offRef.gitAdapter.refs[RELEASE_REF].sha = ids.otherLate;
  await assert.rejects(observeMaintainerPostMerge({
    gitAdapter: offRef.gitAdapter,
    releaseHeadSha: ids.late,
  }), /expectation does not match current durable Git authority/);

  const changing = fixture();
  changing.gitAdapter.refs[RELEASE_REF].sha = ids.late;
  let reads = 0;
  changing.gitAdapter.refReadHook = async (git) => {
    reads += 1;
    if (reads === 2) git.refs[RELEASE_REF].sha = ids.otherLate;
  };
  await assert.rejects(observeMaintainerPostMerge({ gitAdapter: changing.gitAdapter }), /changed while deriving/);

  const current = fixture();
  current.gitAdapter.refs[RELEASE_REF].sha = ids.otherLate;
  const observed = await observeMaintainerPostMerge({ gitAdapter: current.gitAdapter });
  assert.equal(observed.headSha, ids.otherLate);
  assert.equal(observed.verifiedMergeSha, ids.merge);
});

test('trusted main is rebound at the push and GitHub POST boundaries', async () => {
  const pushRace = fixture();
  let pushChecks = 0;
  pushRace.gitAdapter.mainCheckHook = async (git) => {
    pushChecks += 1;
    if (pushChecks === 3) git.refs['refs/heads/main'].sha = ids.otherLate;
  };
  await assert.rejects(
    runFinalizerInvocation({ adapters: pushRace, context: pushRace.context }),
    /(?:trusted current-main binding drifted|finalizer source is not exact current default main)/,
  );
  assert.deepEqual(pushRace.gitAdapter.durableWrites, []);

  const postRace = fixture();
  postRace.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  postRace.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await runFinalizerInvocation({ adapters: postRace, context: postRace.context });
  postRace.gitAdapter.durableWrites.length = 0;
  let postChecks = 0;
  postRace.gitAdapter.mainCheckHook = async (git) => {
    postChecks += 1;
    if (postChecks === 4) git.refs['refs/heads/main'].sha = ids.otherLate;
  };
  let postError;
  try { await runFinalizerInvocation({ adapters: postRace, context: postRace.context }); }
  catch (error) { postError = error; }
  assert.match(postError?.message ?? '', /(?:trusted current-main binding drifted|finalizer source is not exact current default main)/);
  assert.equal(postRace.githubAdapter.durableWrites.length, 0);
  assert.equal(postRace.gitAdapter.refs[RELEASE_ATTEMPT_REF].sha, ids.snapshot);
  assert.ok(postError.evidence, 'spent marker failure retains durable evidence');
  assert.equal(postError.evidence.durableTransitions.at(-1).observedSha, ids.snapshot);
  assert.notEqual(postError.evidence.currentError, undefined);
  assert.doesNotMatch(JSON.stringify(postError.evidence), /GITHUB_TOKEN|authorization|\/tmp\//i);
});

test('spent attempts stably bind every mutable ref and retain evidence across all post-marker races', async () => {
  const releaseFixture = async () => {
    const value = fixture();
    value.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
    value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
    assert.equal((await runFinalizerInvocation({ adapters: value, context: value.context })).action.type, 'authorize-github-release');
    return value;
  };
  const caught = async (promise) => {
    try { await promise; return null; } catch (error) { return error; }
  };

  const markerDrift = await releaseFixture();
  let markerReads = 0;
  markerDrift.gitAdapter.stableRefReadHook = async (git, ref) => {
    if (ref === RELEASE_ATTEMPT_REF && git.refs[ref]?.sha === ids.snapshot && markerReads++ === 0) {
      git.refs[ref].sha = ids.merge;
    }
  };
  const markerError = await caught(runFinalizerInvocation({ adapters: markerDrift, context: markerDrift.context }));
  assert.equal(markerDrift.githubAdapter.durableWrites.length, 0);
  assert.ok(markerError.evidence);
  assert.equal(markerError.evidence.durableTransitions[0].pushAccepted, true);

  const tagDrift = await releaseFixture();
  let refSweeps = 0;
  tagDrift.gitAdapter.refReadHook = async (git) => {
    refSweeps += 1;
    if (refSweeps === 3) git.refs[TAG_REF].sha = ids.merge;
  };
  const tagError = await caught(runFinalizerInvocation({ adapters: tagDrift, context: tagDrift.context }));
  assert.equal(tagDrift.githubAdapter.durableWrites.length, 0);
  assert.ok(tagError.evidence);
  assert.equal(tagError.evidence.postBinding.refs.find(({ ref }) => ref === TAG_REF).observed, ids.merge);

  const mainDrift = await releaseFixture();
  mainDrift.gitAdapter.mainCheckHook = async (git, knownRefs) => {
    if (knownRefs && git.refs[RELEASE_ATTEMPT_REF]?.sha === ids.snapshot) git.refs['refs/heads/main'].sha = ids.otherLate;
  };
  const mainError = await caught(runFinalizerInvocation({ adapters: mainDrift, context: mainDrift.context }));
  assert.equal(mainDrift.githubAdapter.durableWrites.length, 0);
  assert.ok(mainError.evidence);

  const transportFailure = await releaseFixture();
  let transportSweeps = 0;
  transportFailure.gitAdapter.refReadHook = async () => {
    transportSweeps += 1;
    if (transportSweeps === 3) throw new Error('sanitized stable-ref transport failure');
  };
  const transportError = await caught(runFinalizerInvocation({ adapters: transportFailure, context: transportFailure.context }));
  assert.match(transportError.message, /stable-ref transport failure/);
  assert.equal(transportFailure.githubAdapter.durableWrites.length, 0);
  assert.ok(transportError.evidence);

  const crossService = await releaseFixture();
  crossService.githubAdapter.beforeReleaseCreate = async ({ git }) => {
    git.refs[RELEASE_REF].sha = ids.late;
  };
  const crossServiceError = await caught(runFinalizerInvocation({ adapters: crossService, context: crossService.context }));
  assert.equal(crossService.githubAdapter.durableWrites.length, 1);
  assert.ok(crossServiceError.evidence);
  assert.equal(crossServiceError.evidence.postBinding.refs.find(({ ref }) => ref === RELEASE_REF).observed, ids.snapshot);

  const proposal = fixture();
  proposal.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  proposal.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(proposal);
  proposal.gitAdapter.refs[STAGED_REF].sha = ids.nextIntent;
  proposal.gitAdapter.commits.set(ids.nextIntent, {
    sha: ids.nextIntent,
    parents: [ids.reconciliation],
    tree: trees.reconciliation,
    message: nextIntentMessage(ids.reconciliation),
  });
  await runFinalizerInvocation({ adapters: proposal, context: proposal.context });
  proposal.githubAdapter.beforePullCreate = async ({ git }) => { git.refs[STAGED_REF].sha = ids.oldIntent; };
  const proposalError = await caught(runFinalizerInvocation({ adapters: proposal, context: proposal.context }));
  assert.equal(proposal.githubAdapter.durableWrites.filter(({ type }) => type === 'pull').length, 1);
  assert.ok(proposalError.evidence);
  assert.deepEqual(
    proposalError.evidence.postBinding.refs.filter(({ ref }) => [RELEASE_REF, STAGED_REF].includes(ref)).map(({ expected, observed }) => [expected, observed]),
    [[ids.reconciliation, ids.reconciliation], [ids.nextIntent, ids.nextIntent]],
  );

  const postRead = fixture();
  let pullReads = 0;
  postRead.githubAdapter.pullReadHook = async (github) => {
    pullReads += 1;
    if (pullReads === 2) github.pulls[0].base.sha = ids.otherLate;
  };
  const postReadError = await caught(runFinalizerInvocation({ adapters: postRead, context: postRead.context }));
  assert.equal(postRead.gitAdapter.refs[RELEASE_REF].sha, ids.snapshot);
  assert.ok(postReadError.evidence);
  assert.equal(postReadError.evidence.durableTransitions.at(-1).observedSha, ids.snapshot);
  assert.match(postReadError.evidence.currentError.message, /accepted snapshot does not resolve/);
});

test('merged conflict recovery accepts exact J [V,H] with a conflict-resolution tree', async () => {
  const value = fixture();
  value.gitAdapter.refs[RELEASE_REF].sha = ids.recoveryReconciliation;
  value.gitAdapter.refs[RECOVERY_REF] = { sha: ids.late, type: 'commit' };
  value.gitAdapter.mergeTrees.set(`${ids.late} ${ids.snapshot}`, { clean: false, tree: null });
  value.githubAdapter.pulls.push(recoveryPull({
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-07-16T01:00:00Z',
    merge_commit_sha: ids.recoveryReconciliation,
  }));
  const state = await observe(value);
  assert.equal(state.line.kind, 'recovery-j');
  assert.equal(state.line.commit.tree, trees.recovery);
  assert.equal(state.recovery.pull.mergeCommitSha, ids.recoveryReconciliation);

  value.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(value);
  assert.equal(classifyNextAction(await observe(value)).type, 'advance-staged-intent');

  const malformed = fixture();
  malformed.gitAdapter.refs[RECOVERY_REF] = { sha: ids.late, type: 'commit' };
  malformed.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  malformed.gitAdapter.mergeTrees.set(`${ids.late} ${ids.snapshot}`, { clean: false, tree: null });
  malformed.githubAdapter.pulls.push(recoveryPull({ state: 'closed', draft: true }));
  await assert.rejects(observe(malformed), /closed without merging/);
});

test('push protocol disables tag following and distinguishes generic failures from stale leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finalizer-push-'));
  try {
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', work], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', work, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', work, 'commit', '--allow-empty', '-m', 'seed'], { stdio: 'ignore' });
    execFileSync('git', ['-C', work, 'tag', '-a', 'should-not-follow', '-m', 'tag']);
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote]);
    const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const args = buildLeasedPushArguments(RELEASE_REF, null, head);
    assert.ok(args.includes('--no-follow-tags'));
    execFileSync('git', ['-C', work, ...args], { stdio: 'ignore' });
    assert.equal(execFileSync('git', ['-C', work, 'ls-remote', '--tags', 'origin'], { encoding: 'utf8' }), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const generic = fixture();
  generic.gitAdapter.genericPushFailure = true;
  await assert.rejects(
    runFinalizerInvocation({ adapters: generic, context: generic.context }),
    /authentication or transport failure/,
  );
  assert.equal(generic.gitAdapter.refs[RELEASE_REF].sha, ids.merge);
});

test('Git, GitHub, and npm adapters reject hostile configuration and destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finalizer-config-'));
  const oldGitExecPath = process.env.GIT_EXEC_PATH;
  const oldProxy = process.env.HTTPS_PROXY;
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/fablebookjs/lab-01.git']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'first'], { stdio: 'ignore' });
    const firstCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'second'], { stdio: 'ignore' });
    const secondCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', root, 'config', 'push.followTags', 'true']);
    assert.throws(() => new LiveGitAdapter({ cwd: root }).assertClosedTransport(), /UNSAFE_GIT_CONFIG|non-allowlisted setting/);
    execFileSync('git', ['-C', root, 'config', '--unset', 'push.followTags']);
    for (const [key, value] of [
      ['http.proxy', 'http://127.0.0.1:1'],
      ['http.sslVerify', 'false'],
      ['http.sslCAInfo', '/tmp/hostile-ca.pem'],
      ['http.sslCert', '/tmp/hostile-cert.pem'],
      ['http.lowSpeedLimit', '1'],
      ['http.lowSpeedTime', '1'],
      ['credential.helper', '!hostile'],
      ['remote.origin.proxy', 'socks5://127.0.0.1:1'],
      ['remote.origin.uploadpack', '/tmp/hostile-upload-pack'],
      ['include.path', '/tmp/hostile-gitconfig'],
      ['includeIf.gitdir:/tmp/.path', '/tmp/hostile-gitconfig'],
      ['url.https://attacker.invalid/.insteadOf', 'https://github.com/'],
    ]) {
      execFileSync('git', ['-C', root, 'config', key, value]);
      assert.throws(() => new LiveGitAdapter({ cwd: root }).assertClosedTransport(), /UNSAFE_GIT_CONFIG|non-allowlisted setting|rewriting is forbidden/);
      execFileSync('git', ['-C', root, 'config', '--unset-all', key]);
    }
    process.env.GIT_EXEC_PATH = '/tmp/hostile-git-exec';
    assert.throws(() => new LiveGitAdapter({ cwd: root }).assertClosedTransport(), /GIT_EXEC_PATH/);
    delete process.env.GIT_EXEC_PATH;

    const github = new LiveGitHubAdapter();
    assert.throws(() => github.assertRequest('DELETE', `/repos/${REPOSITORY}/releases/1`), /rejects DELETE/);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    assert.throws(() => github.assertRequest('GET', `/repos/${REPOSITORY}`), /hostile inherited HTTP environment/);
    await assert.rejects(new LiveNpmAdapter().observe(PACKAGE_SPECS[0]), /hostile inherited HTTP environment/);

    delete process.env.HTTPS_PROXY;
    execFileSync('git', ['-C', root, 'config', 'http.sslVerify', 'false']);
    let apiReads = 0;
    const neverGitHub = {
      repository: async () => { apiReads += 1; return { full_name: REPOSITORY, default_branch: 'main' }; },
      listPulls: async () => { apiReads += 1; return []; },
      listReleases: async () => { apiReads += 1; return []; },
      operations: [],
    };
    const neverNpm = { observe: async () => { apiReads += 1; return { status: 'absent' }; }, operations: [] };
    await assert.rejects(observeDurableState({
      gitAdapter: new LiveGitAdapter({ cwd: root }),
      githubAdapter: neverGitHub,
      npmAdapter: neverNpm,
      context: { enforceTrustedMain: false },
    }), /UNSAFE_GIT_CONFIG|non-allowlisted setting/);
    assert.equal(apiReads, 0);

    execFileSync('git', ['-C', root, 'config', '--unset', 'http.sslVerify']);
    execFileSync('git', ['-C', root, 'replace', firstCommit, secondCommit]);
    await assert.rejects(observeDurableState({
      gitAdapter: new LiveGitAdapter({ cwd: root }),
      githubAdapter: neverGitHub,
      npmAdapter: neverNpm,
      context: { enforceTrustedMain: false },
    }), /GIT_REPLACE_REFS_PROHIBITED/);
    assert.equal(apiReads, 0);
    execFileSync('git', ['-C', root, 'replace', '-d', firstCommit]);

    const alternateDirectory = join(root, '.git', 'objects', 'info');
    await mkdir(alternateDirectory, { recursive: true });
    await writeFile(join(alternateDirectory, 'alternates'), '/tmp/hostile-object-database\n');
    await assert.rejects(observeDurableState({
      gitAdapter: new LiveGitAdapter({ cwd: root }),
      githubAdapter: neverGitHub,
      npmAdapter: neverNpm,
      context: { enforceTrustedMain: false },
    }), /GIT_ALTERNATES_PROHIBITED/);
    assert.equal(apiReads, 0);
  } finally {
    if (oldGitExecPath === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = oldGitExecPath;
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = oldProxy;
    await rm(root, { recursive: true, force: true });
  }
});

test('spent POST attempts remain query-only through delayed visibility and can explicitly reauthorize definite rejection', async () => {
  const delayed = fixture();
  delayed.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  delayed.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await runFinalizerInvocation({ adapters: delayed, context: delayed.context });
  delayed.githubAdapter.releaseVisibilityDelay = 6;
  delayed.githubAdapter.ambiguousRelease = true;
  const posted = await runFinalizerInvocation({ adapters: delayed, context: delayed.context });
  assert.equal(posted.action.result, 'post-issued-awaiting-stable-visibility');
  assert.equal(delayed.githubAdapter.durableWrites.length, 1);
  let converged = null;
  for (let index = 0; index < 8; index += 1) {
    const queryOnly = await runFinalizerInvocation({ adapters: delayed, context: delayed.context });
    assert.equal(delayed.githubAdapter.durableWrites.length, 1);
    if (queryOnly.action.type === 'complete') {
      converged = queryOnly;
      break;
    }
    assert.equal(queryOnly.action.type, 'await-github-release-visibility');
  }
  assert.ok(converged, 'delayed Release eventually became visible through query-only reruns');
  assert.equal(converged.action.type, 'complete');
  assert.equal(delayed.githubAdapter.durableWrites.length, 1);

  const rejected = fixture();
  rejected.gitAdapter.refs[RELEASE_REF].sha = ids.snapshot;
  rejected.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await runFinalizerInvocation({ adapters: rejected, context: rejected.context });
  rejected.githubAdapter.definiteReleaseRejection = true;
  const rejection = await runFinalizerInvocation({ adapters: rejected, context: rejected.context });
  assert.equal(rejection.action.result, 'definite-client-rejection-recorded');
  assert.equal(rejected.gitAdapter.refs[RELEASE_ATTEMPT_REF].sha, ids.intent);
  assert.equal((await runFinalizerInvocation({ adapters: rejected, context: rejected.context })).action.type, 'reauthorize-github-release');

  const delayedProposal = fixture();
  delayedProposal.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  delayedProposal.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(delayedProposal);
  delayedProposal.gitAdapter.refs[STAGED_REF].sha = ids.nextIntent;
  delayedProposal.gitAdapter.commits.set(ids.nextIntent, {
    sha: ids.nextIntent,
    parents: [ids.reconciliation],
    tree: trees.reconciliation,
    message: nextIntentMessage(ids.reconciliation),
  });
  assert.equal(
    (await runFinalizerInvocation({ adapters: delayedProposal, context: delayedProposal.context })).action.type,
    'authorize-next-proposal',
  );
  delayedProposal.githubAdapter.pullVisibilityDelay = 6;
  delayedProposal.githubAdapter.ambiguousPull = true;
  const proposalPost = await runFinalizerInvocation({ adapters: delayedProposal, context: delayedProposal.context });
  assert.equal(proposalPost.action.result, 'post-issued-awaiting-stable-visibility');
  let proposalConverged = null;
  for (let index = 0; index < 8; index += 1) {
    const queryOnly = await runFinalizerInvocation({ adapters: delayedProposal, context: delayedProposal.context });
    assert.equal(delayedProposal.githubAdapter.durableWrites.filter(({ type }) => type === 'pull').length, 1);
    if (queryOnly.action.type === 'maintain-next-proposal') {
      proposalConverged = queryOnly;
      break;
    }
    assert.equal(queryOnly.action.type, 'await-next-proposal-visibility');
  }
  assert.ok(proposalConverged, 'delayed proposal eventually became visible through query-only reruns');
});

test('authoritative sweeps compare complete hydrated tuples and proposal base SHA binds the current line', async () => {
  const adapter = new LiveGitHubAdapter();
  let sweep = 0;
  adapter.pullSweep = async () => {
    sweep += 1;
    const pull = releasePull();
    if (sweep === 2) pull.body = 'changed between complete sweeps';
    return [pull];
  };
  await assert.rejects(adapter.listPulls(), /changed across two authoritative sweeps/);

  const releases = new LiveGitHubAdapter();
  let releaseSweep = 0;
  releases.releaseSweep = async () => {
    releaseSweep += 1;
    return [{
      id: 501,
      tag_name: 'v1.0.1',
      target_commitish: ids.snapshot,
      name: 'v1.0.1',
      body: releaseSweep === 1 ? 'first body' : 'changed body',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1',
    }];
  };
  await assert.rejects(releases.listReleases(), /changed across two authoritative sweeps/);

  const swappedPull = new LiveGitHubAdapter();
  swappedPull.paginate = async () => [{ id: 1200, number: 12 }];
  swappedPull.request = async () => ({ ...releasePull(), id: 1300, number: 13, html_url: 'https://github.com/fablebookjs/lab-01/pull/13' });
  await assert.rejects(swappedPull.pullSweep(), /does not match requested summary/);

  const swappedRelease = new LiveGitHubAdapter();
  swappedRelease.paginate = async () => [{ id: 500 }];
  swappedRelease.request = async () => ({
    id: 501,
    tag_name: 'v1.0.1',
    target_commitish: ids.snapshot,
    name: 'v1.0.1',
    body: 'body',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/fablebookjs/lab-01/releases/tag/v1.0.1',
  });
  await assert.rejects(swappedRelease.releaseSweep(), /does not match requested summary/);

  const createdPull = new LiveGitHubAdapter();
  createdPull.request = async (method) => method === 'POST'
    ? { id: 1001, number: 101 }
    : { ...releasePull(), id: 1002, number: 102, html_url: 'https://github.com/fablebookjs/lab-01/pull/102' };
  await assert.rejects(createdPull.createPullRequest({
    title: 'release: propose v1.0.2', body: 'body', head: 'staged/v1.0', base: 'releases/v1.0', draft: true,
    expectedHeadSha: ids.nextIntent, expectedBaseSha: ids.reconciliation,
  }), /does not match its POST identity/);

  const createdRelease = new LiveGitHubAdapter();
  createdRelease.request = async (method) => method === 'POST'
    ? { id: 500 }
    : { id: 501 };
  await assert.rejects(createdRelease.createRelease({
    tagName: 'v1.0.1', targetSha: ids.snapshot, body: 'body', expectedLineSha: ids.snapshot, expectedTagSha: ids.snapshot,
  }), /does not match its POST identity/);

  const stringIdentity = new LiveGitHubAdapter();
  stringIdentity.request = async () => [{ number: '12' }];
  await assert.rejects(stringIdentity.paginate('/repos/fablebookjs/lab-01/pulls?state=all&sort=created&direction=asc'), /exact positive number/);

  for (const id of [undefined, null, '1200']) {
    const invalidId = new LiveGitHubAdapter();
    invalidId.request = async () => [{ number: 12, ...(id === undefined ? {} : { id }) }];
    await assert.rejects(
      invalidId.paginate(`/repos/${REPOSITORY}/pulls?state=all&sort=created&direction=asc`),
      /missing, invalid, or aliased pull id/,
    );
  }

  const aliasedIdentity = new LiveGitHubAdapter();
  aliasedIdentity.request = async () => [{ number: 12, id: 1200 }, { number: 13, id: 1200 }];
  await assert.rejects(aliasedIdentity.paginate('/repos/fablebookjs/lab-01/pulls?state=all&sort=created&direction=asc'), /aliased pull id/);

  const missingPostId = new LiveGitHubAdapter();
  missingPostId.request = async () => ({ number: 101 });
  await assert.rejects(missingPostId.createPullRequest({
    title: 'release: propose v1.0.2', body: 'body', head: 'staged/v1.0', base: 'releases/v1.0', draft: true,
    expectedHeadSha: ids.nextIntent, expectedBaseSha: ids.reconciliation,
  }), /exact positive number\/id/);

  const staleBase = fixture();
  staleBase.gitAdapter.refs[RELEASE_REF].sha = ids.reconciliation;
  staleBase.gitAdapter.refs[TAG_REF] = { sha: ids.snapshot, type: 'commit' };
  await installExactRelease(staleBase);
  staleBase.gitAdapter.refs[STAGED_REF].sha = ids.nextIntent;
  staleBase.gitAdapter.refs[PROPOSAL_ATTEMPT_REF] = { sha: ids.nextIntent, type: 'commit' };
  staleBase.gitAdapter.commits.set(ids.nextIntent, {
    sha: ids.nextIntent,
    parents: [ids.reconciliation],
    tree: trees.reconciliation,
    message: nextIntentMessage(ids.reconciliation),
  });
  const proposalState = await observe(staleBase);
  staleBase.githubAdapter.pulls.push({
    number: 101,
    state: 'open',
    draft: true,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    html_url: 'https://github.com/fablebookjs/lab-01/pull/101',
    title: 'release: propose v1.0.2',
    body: nextProposalBody(proposalState),
    head: { ref: 'staged/v1.0', sha: ids.nextIntent, repo: { full_name: REPOSITORY } },
    base: { ref: 'releases/v1.0', sha: ids.snapshot, repo: { full_name: REPOSITORY } },
  });
  await assert.rejects(observe(staleBase), /(?:incompatible head\/base|lifecycle source is incompatible)/);
});

test('preservation evidence records full observed tuple changes and instrumented scope boundaries', async () => {
  const value = fixture();
  let reads = 0;
  value.githubAdapter.pullReadHook = async (github) => {
    reads += 1;
    if (reads === 2) github.pulls[1].body = 'calibration changed externally';
  };
  const evidence = await runFinalizerInvocation({ adapters: value, context: value.context });
  assert.equal(evidence.preservation.changedPulls.length, 1);
  assert.equal(evidence.preservation.changedPulls[0].before.number, 99);
  assert.equal(evidence.preservation.changedPulls[0].after.body, 'calibration changed externally');
  assert.equal(evidence.preservation.assessment.allGitWritesAllowlisted, true);
  assert.equal(evidence.preservation.assessment.allGitHubWritesAllowlisted, true);
  assert.equal(evidence.preservation.assessment.npmTransportReadOnly, true);
  assert.match(evidence.preservation.assessment.externalEpistemicBoundary, /finalizer process/);

  const source = await readFile(new URL('../scripts/finalize-release.mjs', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/finalize-release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(`${source}\n${workflow}`, /storybookjs\//i);
  assert.doesNotMatch(`${source}\n${workflow}`, /npm\s+(?:publish|token|login|adduser)/i);
});
