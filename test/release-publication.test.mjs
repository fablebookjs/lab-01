import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';

import {
  assertTrustedPreparationMain,
  ensureSnapshotRef,
  retainedArtifactAvailable,
  liveAdapter as snapshotLiveAdapter,
  validateLatestMergedAuthority,
} from '../scripts/prepare-release-snapshot.mjs';
import {
  applyPublicationState,
  assertTrustedMain,
  durableNpmState,
  lineRelation,
  publishFromSnapshot,
} from '../scripts/publish-npm.mjs';
import {
  PACKAGE_SPECS,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_ID,
  REPOSITORY_OWNER_ID,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  TRANSFORMED_FILES,
  assertNoAmbientGitConfiguration,
  assertSafeGitConfiguration,
  buildSnapshotMessage,
  command,
  createClosedNpmEnvironment,
  deriveTrustedSnapshotAuthority,
  materializeInertPackages,
  githubProvenanceClaims,
  parseSnapshotMessage,
  readBlob,
  reconstructExpectedSnapshot,
  validateExactSnapshotTree,
  validateManifest,
} from '../scripts/release-publication.mjs';
import {
  assertNoAmbientPackageConfiguration,
  assertNoProjectNpmrc,
  bootstrapNpm,
} from '../scripts/bootstrap-npm-cli.mjs';
import { command as qaCommand } from '../scripts/qa-ready-release.mjs';

const sourceRoot = new URL('../', import.meta.url);
const checkedOutPackageVersion = process.env.LAB_01_EXPECTED_PACKAGE_VERSION ?? '1.0.0';
const hex = (digit) => digit.repeat(40);
const sourceSha = hex('1');
const stagedSha = hex('2');
const mergeSha = hex('3');
const snapshotSha = hex('4');
const transformedTree = hex('6');
const contentSha256 = 'a'.repeat(64);
const integrities = [
  `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
];
const packages = PACKAGE_SPECS.map((spec, index) => ({
  name: spec.name,
  integrity: integrities[index],
  shasum: String(index + 1).repeat(40),
}));

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
}

async function repositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lab-01-release-fixture-'));
  for (const path of [
    'package.json',
    'package-lock.json',
    'packages/core/package.json',
    'packages/core/src/index.js',
    'packages/addon/package.json',
    'packages/addon/src/index.js',
  ]) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    const committedBaseline = execFileSync('git', ['show', `HEAD:${path}`], { cwd: process.cwd() });
    await writeFile(join(directory, path), committedBaseline);
  }
  git(directory, 'init', '-q');
  git(directory, 'remote', 'add', 'origin', 'https://github.com/fablebookjs/lab-01.git');
  git(directory, 'add', '.');
  git(directory, 'commit', '-qm', 'baseline');
  const source = git(directory, 'rev-parse', 'HEAD');
  const tree = git(directory, 'rev-parse', 'HEAD^{tree}');
  const staged = git(
    directory,
    'commit-tree', tree, '-p', source, '-m',
    `release: propose v${RELEASE_VERSION}\n\nRelease-Intent-Version: 1\nRelease-Line: ${RELEASE_LINE}\nRelease-Version: ${RELEASE_VERSION}\nRelease-Source: ${source}\n`,
  );
  const merge = git(directory, 'commit-tree', tree, '-p', source, '-p', staged, '-m', 'Merge pull request #12');
  return { directory, source, staged, merge };
}

function snapshotMessage(overrides = {}) {
  return buildSnapshotMessage({
    mergeSha,
    stagedSha,
    sourceSha,
    tree: transformedTree,
    contentSha256,
    packages,
    ...overrides,
  });
}

test('V metadata is deterministic across equivalent QA run IDs and binds tree/content', () => {
  const first = snapshotMessage();
  const second = snapshotMessage({ qaRunId: 99 });
  assert.equal(first, second);
  assert.doesNotMatch(first, /Release-QA-Run/);
  assert.match(first, new RegExp(`Release-Tree: ${transformedTree}`));
  assert.match(first, new RegExp(`Release-Content-SHA256: ${contentSha256}`));
  const parsed = parseSnapshotMessage(first);
  assert.equal(parsed.tree, transformedTree);
  assert.equal(parsed.contentSha256, contentSha256);
});

function authorityFixture() {
  const pull = {
    id: 12,
    number: 12,
    state: 'closed',
    draft: false,
    merged: true,
    merged_at: '2026-07-15T10:00:00Z',
    base: { repo: { full_name: REPOSITORY }, ref: RELEASE_LINE, sha: sourceSha },
    head: { repo: { full_name: REPOSITORY }, ref: 'staged/v1.0', sha: stagedSha },
    merge_commit_sha: mergeSha,
  };
  return {
    pull,
    pulls: [structuredClone(pull)],
    runs: [
      { id: 98, name: 'Ready release QA controller', created_at: '2026-07-15T10:01:00Z', status: 'completed', conclusion: 'success', path: '.github/workflows/ready-release-qa-controller.yml', head_branch: 'main', head_sha: sourceSha, event: 'workflow_run', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, artifact_names: [`ready-release-qa-${stagedSha}`] },
      { id: 99, name: 'Ready release QA controller', created_at: '2026-07-15T10:02:00Z', status: 'completed', conclusion: 'success', path: '.github/workflows/ready-release-qa-controller.yml', head_branch: 'main', head_sha: sourceSha, event: 'workflow_dispatch', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, artifact_names: [`ready-release-qa-${stagedSha}`] },
    ],
    prNumber: '12',
    qaRunExpectation: '',
  };
}

test('preparation requires the unique latest merged lifecycle PR and latest successful exact-head QA', () => {
  const fixture = authorityFixture();
  assert.equal(validateLatestMergedAuthority(fixture).canonicalRun.id, 99);
  assert.equal(validateLatestMergedAuthority({ ...fixture, qaRunExpectation: '99' }).canonicalRun.id, 99);

  const older = structuredClone(fixture.pull);
  older.id = 11;
  older.number = 11;
  older.merged_at = '2026-07-15T09:00:00Z';
  const newer = structuredClone(fixture.pull);
  newer.id = 13;
  newer.number = 13;
  newer.merged_at = '2026-07-15T11:00:00Z';
  assert.throws(
    () => validateLatestMergedAuthority({ ...fixture, pull: older, pulls: [older, newer], prNumber: '11' }),
    /LATEST_MERGED_RELEASE_PR_MISMATCH/,
  );
  assert.throws(
    () => validateLatestMergedAuthority({ ...fixture, qaRunExpectation: '98' }),
    /QA_RUN_EXPECTATION_STALE/,
  );
  const wrongHead = structuredClone(fixture);
  wrongHead.runs.forEach((run) => { run.artifact_names = ['ready-release-qa-wrong']; });
  assert.throws(() => validateLatestMergedAuthority(wrongHead), /CURRENT_READY_QA_AUTHORIZATION_MISSING/);
});

test('snapshot authority reads and hydrates more than 100 PRs and QA runs across two complete stable sweeps', async () => {
  const unrelatedPulls = Array.from({ length: 100 }, (_, index) => ({
    id: 1000 + index,
    number: index + 1,
    state: 'closed', draft: false, merged: false, merged_at: null, merge_commit_sha: null,
    base: { repo: { full_name: REPOSITORY }, ref: 'main', sha: sourceSha },
    head: { repo: { full_name: REPOSITORY }, ref: `unrelated/${index + 1}`, sha: stagedSha },
  }));
  const lifecycle = { ...structuredClone(authorityFixture().pull), id: 2000, number: 101 };
  const pulls = [...unrelatedPulls, lifecycle];
  const runs = Array.from({ length: 101 }, (_, index) => ({
    id: 3000 + index,
    name: 'Ready release QA controller',
    path: '.github/workflows/ready-release-qa-controller.yml',
    event: index % 2 ? 'workflow_dispatch' : 'workflow_run',
    status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: sourceSha,
    created_at: `2026-07-15T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`,
    updated_at: '2026-07-15T12:00:00Z',
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
  }));
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'read-only-test-token';
  const collectionCounts = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const page = Number(parsed.searchParams.get('page') ?? '1');
    let body;
    if (parsed.pathname === `/repos/${REPOSITORY}/pulls`) {
      collectionCounts.set('pulls', (collectionCounts.get('pulls') ?? 0) + 1);
      body = pulls.slice((page - 1) * 100, page * 100);
    } else if (/\/pulls\/[1-9]\d*$/.test(parsed.pathname)) {
      body = pulls.find(({ number }) => String(number) === parsed.pathname.split('/').at(-1));
    } else if (parsed.pathname.endsWith('/actions/workflows/ready-release-qa-controller.yml/runs')) {
      collectionCounts.set('runs', (collectionCounts.get('runs') ?? 0) + 1);
      body = { workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    } else if (/\/actions\/runs\/[1-9]\d*\/artifacts$/.test(parsed.pathname)) {
      const id = Number(parsed.pathname.split('/').at(-2));
      body = { artifacts: page === 1 ? [{ id: 9000 + id, name: `ready-release-qa-${stagedSha}`, expired: false }] : [] };
    } else if (/\/actions\/runs\/[1-9]\d*$/.test(parsed.pathname)) {
      body = runs.find(({ id }) => String(id) === parsed.pathname.split('/').at(-1));
    } else {
      throw new Error(`unexpected mocked GitHub path ${path}`);
    }
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  try {
    assert.equal((await snapshotLiveAdapter.releasePulls()).length, 101);
    assert.equal((await snapshotLiveAdapter.qaRuns()).length, 101);
    assert.equal(collectionCounts.get('pulls'), 4);
    assert.equal(collectionCounts.get('runs'), 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test('expired, missing, or unreadable retained artifacts do not prevent trusted regeneration', async () => {
  assert.equal(await retainedArtifactAvailable({ artifacts: async () => ({ artifacts: [{ expired: false }] }) }, 99), true);
  assert.equal(await retainedArtifactAvailable({ artifacts: async () => ({ artifacts: [{ expired: true }] }) }, 99), false);
  assert.equal(await retainedArtifactAvailable({ artifacts: async () => { throw new Error('expired artifact raw path'); } }, 99), false);
});

test('snapshot ref creation uses one mocked write and converges after reuse or lost response', async () => {
  function harness({ initial = null, ambiguous = false } = {}) {
    let current = initial;
    const writes = [];
    return {
      writes,
      adapter: {
        ref: async () => current,
        pushSnapshot: async (_root, value) => {
          writes.push(value);
          current = value;
          if (ambiguous) throw Object.assign(new Error('private raw output'), { code: 'SNAPSHOT_REF_WRITE_FAILED' });
        },
      },
    };
  }
  const created = harness();
  assert.equal(await ensureSnapshotRef({ adapter: created.adapter, repoRoot: '/mock', snapshotSha }), 'created');
  assert.deepEqual(created.writes, [snapshotSha]);
  assert.equal(await ensureSnapshotRef({ adapter: harness({ initial: snapshotSha }).adapter, repoRoot: '/mock', snapshotSha }), 'reused');
  assert.equal(
    await ensureSnapshotRef({ adapter: harness({ ambiguous: true }).adapter, repoRoot: '/mock', snapshotSha }),
    'created-after-ambiguous-response',
  );
  await assert.rejects(
    ensureSnapshotRef({ adapter: harness({ initial: sourceSha }).adapter, repoRoot: '/mock', snapshotSha }),
    /EXISTING_SNAPSHOT_INCOMPATIBLE/,
  );
});

test('trusted reconstruction rejects a forged V with extra core source', async () => {
  const fixture = await repositoryFixture();
  try {
    const index = join(fixture.directory, 'index');
    const expected = reconstructExpectedSnapshot(fixture.directory, fixture.merge, index);
    const valid = git(fixture.directory, 'commit-tree', expected.tree, '-p', fixture.merge, '-m', 'valid V');
    assert.doesNotThrow(() => validateExactSnapshotTree(fixture.directory, fixture.merge, valid, expected.tree));

    const forgedIndex = join(fixture.directory, 'forged-index');
    git(fixture.directory, 'read-tree', `--index-output=${forgedIndex}`, expected.tree);
    const extra = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: fixture.directory, input: 'export const forged = true;\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: fixture.directory,
      env: { ...process.env, GIT_INDEX_FILE: forgedIndex },
      input: `100644 ${extra}\tpackages/core/src/extra.js\n`,
    });
    const forgedTree = execFileSync('git', ['write-tree'], { cwd: fixture.directory, env: { ...process.env, GIT_INDEX_FILE: forgedIndex }, encoding: 'utf8' }).trim();
    const forged = git(fixture.directory, 'commit-tree', forgedTree, '-p', fixture.merge, '-m', 'forged V');
    assert.throws(
      () => validateExactSnapshotTree(fixture.directory, fixture.merge, forged, expected.tree),
      /SNAPSHOT_GRAPH_OR_TREE_INVALID/,
    );
    await assert.rejects(
      materializeInertPackages(fixture.directory, forgedTree, join(fixture.directory, 'inert')),
      /PACKAGE_TREE_INVALID_CORE/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('shared schema-2 authority rejects executable, extra-field, extra-file, and invalid-byte V forgeries', async () => {
  const fixture = await repositoryFixture();
  const rawIdentity = (tree) => {
    const hash = createHash('sha256');
    for (const path of TRANSFORMED_FILES) {
      hash.update(path);
      hash.update('\0');
      hash.update(readBlob(fixture.directory, tree, path));
      hash.update('\0');
    }
    return hash.digest('hex');
  };
  const forgedTree = (name, mutate) => {
    const index = join(fixture.directory, `${name}-index`);
    git(fixture.directory, 'read-tree', `--index-output=${index}`, expected.tree);
    const writeBlob = (path, bytes, mode = '100644') => {
      const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: fixture.directory,
        input: bytes,
      }).toString().trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `${mode},${object},${path}`], {
        cwd: fixture.directory,
        env: { ...process.env, GIT_INDEX_FILE: index },
      });
    };
    mutate({ writeBlob });
    return execFileSync('git', ['write-tree'], {
      cwd: fixture.directory,
      env: { ...process.env, GIT_INDEX_FILE: index },
      encoding: 'utf8',
    }).trim();
  };
  const commitForged = (tree, name) => {
    const message = buildSnapshotMessage({
      mergeSha: fixture.merge,
      stagedSha: fixture.staged,
      sourceSha: fixture.source,
      tree,
      contentSha256: rawIdentity(tree),
      packages,
    });
    return git(fixture.directory, 'commit-tree', tree, '-p', fixture.merge, '-m', message, '-m', name);
  };
  let expected;
  try {
    expected = reconstructExpectedSnapshot(fixture.directory, fixture.merge, join(fixture.directory, 'expected-index'));
    const coreManifest = readBlob(fixture.directory, expected.tree, 'packages/core/package.json');
    const extraManifest = JSON.parse(coreManifest);
    extraManifest.scripts = { prepare: 'forged' };
    const cases = [
      ['executable', forgedTree('executable', ({ writeBlob }) => writeBlob('packages/core/package.json', coreManifest, '100755'))],
      ['extra-field', forgedTree('extra-field', ({ writeBlob }) => writeBlob('packages/core/package.json', Buffer.from(`${JSON.stringify(extraManifest, null, 2)}\n`)))],
      ['extra-file', forgedTree('extra-file', ({ writeBlob }) => writeBlob('packages/core/src/extra.js', Buffer.from('export const forged = true;\n')))],
      ['invalid-byte', forgedTree('invalid-byte', ({ writeBlob }) => writeBlob('package-lock.json', Buffer.from([0xff, 0xfe, 0x00, 0x0a])))],
    ];
    for (const [name, tree] of cases) {
      const snapshot = commitForged(tree, name);
      await assert.rejects(
        deriveTrustedSnapshotAuthority(fixture.directory, snapshot, { temporaryBase: fixture.directory }),
        /SNAPSHOT_(?:GRAPH_OR_TREE|DIFF_ALLOWLIST|MODE)_INVALID/,
        name,
      );
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('package manifests use an exact inert public allowlist', async () => {
  for (const spec of PACKAGE_SPECS) {
    const manifest = JSON.parse(await readFile(new URL(`${spec.directory}/package.json`, sourceRoot), 'utf8'));
    assert.doesNotThrow(() => validateManifest(manifest, spec, checkedOutPackageVersion));
    for (const [key, value] of [
      ['scripts', { prepare: 'exfiltrate' }], ['bin', 'src/index.js'], ['bundledDependencies', ['x']],
      ['gypfile', true], ['publishConfig', { registry: 'https://attacker.invalid/' }], ['config', { registry: 'x' }],
    ]) {
      assert.throws(() => validateManifest({ ...manifest, [key]: value }, spec, checkedOutPackageVersion), /MANIFEST_KEYS_INVALID/);
    }
  }
});

function present(artifact) {
  const spec = PACKAGE_SPECS.find(({ name }) => name === artifact.name);
  return {
    status: 'present', name: artifact.name, version: RELEASE_VERSION,
    repository: { type: 'git', url: REPOSITORY_URL, directory: spec.directory },
    integrity: artifact.integrity, shasum: artifact.shasum,
  };
}

function publicationHarness(initial, { ambiguous = false } = {}) {
  const state = new Map(initial.map((item, index) => [PACKAGE_SPECS[index].name, item]));
  const publishes = [];
  return {
    publishes,
    adapter: {
      query: async (spec) => structuredClone(state.get(spec.name)),
      publish: async (artifact) => {
        publishes.push(artifact.name);
        state.set(artifact.name, present(artifact));
        if (ambiguous) throw Object.assign(new Error('private registry response'), { code: 'NPM_PUBLISH_FAILED' });
      },
    },
  };
}

test('core-first publication, canonical partial continuation, and reruns converge', async () => {
  const artifacts = packages.map((item, index) => ({ ...PACKAGE_SPECS[index], ...item, tarball: `/private/${index}.tgz` }));
  const absent = PACKAGE_SPECS.map(({ name }) => ({ status: 'absent', name }));
  const first = publicationHarness(absent);
  assert.equal((await applyPublicationState({ choice: 'core', artifacts, adapter: first.adapter, npmEnvironment: {} })).result, 'published-and-verified');
  assert.deepEqual(first.publishes, [PACKAGE_SPECS[0].name]);
  const continuation = publicationHarness([present(artifacts[0]), absent[1]]);
  assert.equal((await applyPublicationState({ choice: 'addon', artifacts, adapter: continuation.adapter, npmEnvironment: {} })).result, 'published-and-verified');
  const rerun = publicationHarness([present(artifacts[0]), present(artifacts[1])]);
  assert.equal((await applyPublicationState({ choice: 'addon', artifacts, adapter: rerun.adapter, npmEnvironment: {} })).result, 'reused');
  const lost = publicationHarness(absent, { ambiguous: true });
  assert.equal((await applyPublicationState({ choice: 'core', artifacts, adapter: lost.adapter, npmEnvironment: {} })).result, 'published-after-ambiguous-response');
});

test('publisher rejects inverse partial, wrong order, and mismatching durable state', async () => {
  const artifacts = packages.map((item, index) => ({ ...PACKAGE_SPECS[index], ...item, tarball: `/private/${index}.tgz` }));
  const absent = PACKAGE_SPECS.map(({ name }) => ({ status: 'absent', name }));
  await assert.rejects(
    applyPublicationState({ choice: 'addon', artifacts, adapter: publicationHarness(absent).adapter, npmEnvironment: {} }),
    /ADDON_BLOCKED_UNTIL_CORE/,
  );
  await assert.rejects(
    applyPublicationState({ choice: 'core', artifacts, adapter: publicationHarness([absent[0], present(artifacts[1])]).adapter, npmEnvironment: {} }),
    /NPM_INVERSE_PARTIAL_STATE/,
  );
  const mismatch = present(artifacts[0]);
  mismatch.integrity = integrities[1];
  await assert.rejects(
    applyPublicationState({ choice: 'core', artifacts, adapter: publicationHarness([mismatch, absent[1]]).adapter, npmEnvironment: {} }),
    /NPM_INTEGRITY_INCOMPATIBLE_CORE/,
  );
});

test('bounded durable registry readback names exact matching, absent, mismatching, and unknown package states', async () => {
  const artifacts = packages.map((item, index) => ({ ...PACKAGE_SPECS[index], ...item }));
  const exact = await durableNpmState({
    query: async (spec) => spec.choice === 'core' ? present(artifacts[0]) : { status: 'absent', name: spec.name },
  }, artifacts, 50);
  assert.deepEqual(exact.map(({ name, status }) => ({ name, status })), [
    { name: PACKAGE_SPECS[0].name, status: 'matching' },
    { name: PACKAGE_SPECS[1].name, status: 'absent' },
  ]);

  const mismatching = await durableNpmState({ query: async (spec) => ({ ...present(artifacts.find(({ name }) => name === spec.name)), integrity: 'sha512-wrong' }) }, artifacts, 50);
  assert.deepEqual(mismatching.map(({ name, status, code }) => ({ name, status, code })), [
    { name: PACKAGE_SPECS[0].name, status: 'mismatching', code: 'NPM_DURABLE_MISMATCH_CORE' },
    { name: PACKAGE_SPECS[1].name, status: 'mismatching', code: 'NPM_DURABLE_MISMATCH_ADDON' },
  ]);

  const unavailable = await durableNpmState({ query: async () => { throw new Error('raw registry diagnostics'); } }, artifacts, 50);
  assert.deepEqual(unavailable.map(({ name, status, code }) => ({ name, status, code })), [
    { name: PACKAGE_SPECS[0].name, status: 'unknown', code: 'NPM_DURABLE_READ_FAILED_CORE' },
    { name: PACKAGE_SPECS[1].name, status: 'unknown', code: 'NPM_DURABLE_READ_FAILED_ADDON' },
  ]);
  assert.doesNotMatch(JSON.stringify(unavailable), /raw registry diagnostics/);

  const timedOut = await durableNpmState({ query: async () => new Promise(() => {}) }, artifacts, 5);
  assert.deepEqual(timedOut.map(({ name, status, code }) => ({ name, status, code })), [
    { name: PACKAGE_SPECS[0].name, status: 'unknown', code: 'NPM_DURABLE_READ_TIMEOUT_CORE' },
    { name: PACKAGE_SPECS[1].name, status: 'unknown', code: 'NPM_DURABLE_READ_TIMEOUT_ADDON' },
  ]);
});

test('late release-line descendants do not block package publication but reconciled V does', async () => {
  const fixture = await repositoryFixture();
  try {
    const merge = fixture.merge;
    const late = git(fixture.directory, 'commit-tree', git(fixture.directory, 'rev-parse', `${merge}^{tree}`), '-p', merge, '-m', 'late X');
    const snapshot = git(fixture.directory, 'commit-tree', git(fixture.directory, 'rev-parse', `${merge}^{tree}`), '-p', merge, '-m', 'V');
    assert.equal(lineRelation(fixture.directory, merge, snapshot, merge), 'at-merge');
    assert.equal(lineRelation(fixture.directory, merge, snapshot, late), 'late-descendant');
    const reconciled = git(fixture.directory, 'commit-tree', git(fixture.directory, 'rev-parse', `${merge}^{tree}`), '-p', snapshot, '-m', 'reconciled');
    assert.throws(() => lineRelation(fixture.directory, merge, snapshot, reconciled), /RELEASE_LINE_RECONCILED_BEFORE_PUBLICATION/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('npm and Git configuration attacks fail before tooling or transport', async () => {
  assert.throws(() => assertNoAmbientPackageConfiguration({ npm_config_registry: 'https://attacker.invalid/' }), /AMBIENT_PACKAGE_CONFIG_PROHIBITED/);
  assert.throws(() => assertNoAmbientGitConfiguration({ HTTPS_PROXY: 'https://attacker.invalid/' }), /AMBIENT_GIT_CONFIG_PROHIBITED/);
  const fixture = await repositoryFixture();
  try {
    await writeFile(join(fixture.directory, '.npmrc'), 'registry=https://attacker.invalid/\n');
    await assert.rejects(assertNoProjectNpmrc(fixture.directory), /PROJECT_NPM_CONFIG_PROHIBITED/);
    await rm(join(fixture.directory, '.npmrc'));
    git(fixture.directory, 'config', '--local', 'credential.helper', 'attacker');
    assert.throws(() => assertSafeGitConfiguration(fixture.directory), /UNSAFE_GIT_CONFIG/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('closed npm environment strips tokens, ambient registry, and project cwd authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-01-publish-env-'));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NPM_TOKEN: 'ambient', NODE_AUTH_TOKEN: 'ambient', NPM_CONFIG_REGISTRY: 'https://attacker.invalid/' });
    const env = await createClosedNpmEnvironment(directory);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/');
    assert.match(await readFile(env.NPM_CONFIG_USERCONFIG, 'utf8'), /^@fablebook:registry=https:\/\/registry\.npmjs\.org\/$/m);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('pinned npm provenance claims retain the exact immutable GitHub repository, workflow, run, and source identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-01-provenance-env-'));
  const previous = { ...process.env };
  const sha = 'a'.repeat(40);
  const fixture = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/example/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-oidc-request-token',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID,
    GITHUB_REPOSITORY_OWNER_ID: REPOSITORY_OWNER_ID,
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_RUN_ID: '700',
    GITHUB_RUN_NUMBER: '31',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW: 'Publish npm package',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: sha,
    RUNNER_ENVIRONMENT: 'github-hosted',
  };
  try {
    Object.assign(process.env, fixture, {
      NPM_TOKEN: 'ambient-token',
      NODE_AUTH_TOKEN: 'ambient-token',
      GITHUB_ACTOR: 'unnecessary-ambient-claim',
    });
    const claims = githubProvenanceClaims();
    assert.deepEqual(claims, {
      workflow: {
        ref: 'refs/heads/main',
        repository: `https://github.com/${REPOSITORY}`,
        path: '.github/workflows/publish-npm.yml',
      },
      github: {
        event_name: 'workflow_dispatch',
        repository_id: REPOSITORY_ID,
        repository_owner_id: REPOSITORY_OWNER_ID,
      },
      dependency: {
        uri: `git+https://github.com/${REPOSITORY}@refs/heads/main`,
        digest: { gitCommit: sha },
      },
      builder: { id: 'https://github.com/actions/runner/github-hosted' },
      invocationId: `https://github.com/${REPOSITORY}/actions/runs/700/attempts/2`,
    });
    const env = await createClosedNpmEnvironment(directory, { oidc: true });
    assert.deepEqual(
      Object.fromEntries(Object.keys(fixture).map((key) => [key, env[key]])),
      fixture,
    );
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.equal(env.GITHUB_ACTOR, undefined);

    for (const [key, bad] of [
      ['GITHUB_SERVER_URL', 'https://github.example.invalid'],
      ['GITHUB_REPOSITORY_OWNER_ID', '1'],
      ['GITHUB_WORKFLOW_REF', `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`],
      ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
      ['GITHUB_RUN_ID', '0'],
    ]) {
      const forged = { ...fixture, [key]: bad };
      assert.throws(() => githubProvenanceClaims(forged), /GitHub OIDC/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('raw child output, causes, properties, and temp paths never cross an error boundary', async () => {
  const secret = `SECRET-${Date.now()}-/private/tmp/path`;
  let observed;
  try {
    await command(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(9)`], { errorCode: 'SANITIZED_FAILURE' });
  } catch (error) {
    observed = error;
  }
  assert.equal(observed.code, 'SANITIZED_FAILURE');
  for (const serialized of [String(observed), inspect(observed, { showHidden: true }), JSON.stringify(observed), JSON.stringify({ ...observed })]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(serialized, /private\/tmp\/path/);
  }
  assert.equal(observed.cause, undefined);
  assert.deepEqual(Object.keys(observed).sort(), ['code']);

  let qaError;
  try {
    await qaCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(9)`]);
  } catch (error) {
    qaError = error;
  }
  assert.equal(qaError.message, 'QA_SUBPROCESS_FAILED');
  assert.equal(qaError.cause, undefined);
  assert.doesNotMatch(inspect(qaError, { showHidden: true }), /SECRET-|private\/tmp\/path/);
});

test('trusted-main identity requires local HEAD, remote main, dispatch SHA, workflow SHA, and main ref', async () => {
  const fixture = await repositoryFixture();
  const previous = { ...process.env };
  try {
    const head = git(fixture.directory, 'rev-parse', 'HEAD');
    Object.assign(process.env, { EXPECTED_DISPATCH_SHA: head, EXPECTED_WORKFLOW_SHA: head, GITHUB_REF: 'refs/heads/main' });
    assert.equal(assertTrustedMain(fixture.directory, () => head), head);
    assert.equal(await assertTrustedPreparationMain(fixture.directory, { ref: async () => head }), head);
    process.env.EXPECTED_WORKFLOW_SHA = sourceSha;
    assert.throws(() => assertTrustedMain(fixture.directory, () => head), /TRUSTED_MAIN_IDENTITY_MISMATCH/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('publisher writes sanitized durable evidence even when validation stops before publication', async () => {
  const fixture = await repositoryFixture();
  const evidencePath = join(fixture.directory, '..', `publish-evidence-${Date.now()}.json`);
  const previous = { ...process.env };
  const head = git(fixture.directory, 'rev-parse', 'HEAD');
  try {
    Object.assign(process.env, { EXPECTED_DISPATCH_SHA: head, EXPECTED_WORKFLOW_SHA: head, GITHUB_REF: 'refs/heads/main' });
    const npmAdapter = {
      query: async (spec) => ({ status: 'absent', name: spec.name }),
      publish: async () => { throw new Error('must not publish'); },
    };
    await assert.rejects(publishFromSnapshot({
      repoRoot: fixture.directory,
      choice: 'core',
      evidencePath,
      npmAdapter,
      refAdapter: (_root, ref) => (ref === 'refs/heads/main' ? head : null),
      fetchAdapter: () => {},
      oidc: false,
    }));
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    assert.equal(evidence.status, 'failed');
    assert.deepEqual(evidence.npm.durable.map(({ status }) => status), ['absent', 'absent']);
    assert.equal(typeof evidence.error.code, 'string');
    assert.doesNotMatch(JSON.stringify(evidence), /must not publish|private|tmp\/lab-01-publish/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(evidencePath, { force: true });
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('npm bootstrap creates an absent root before configs across concurrent fresh runs and clean reruns', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lab-01-bootstrap-order-'));
  const previous = { ...process.env };
  const calls = [];
  const npmRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd });
    return { stdout: args[0] === '--version' ? '11.18.0\n' : '', stderr: '' };
  };
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(?:npm_config_|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$|NO_PROXY$|no_proxy$|CURL_CA_BUNDLE$|SSL_CERT_FILE$)/.test(key)) {
        delete process.env[key];
      }
    }
    const runs = Array.from({ length: 32 }, (_, index) => ({
      base: join(parent, `fresh-${index}`),
      pathFile: join(parent, `fresh-${index}`, 'github-path'),
    }));
    const results = await Promise.all(runs.map(({ base, pathFile }) => bootstrapNpm({
      repoRoot: process.cwd(),
      base,
      pathFile,
      npmRunner,
    })));
    assert.ok(results.every(({ version }) => version === '11.18.0'));
    for (const { base, pathFile } of runs) {
      const root = join(base, 'lab-01-npm-bootstrap');
      assert.equal(await readFile(join(root, 'user.npmrc'), 'utf8'), 'registry=https://registry.npmjs.org/\n@fablebook:registry=https://registry.npmjs.org/\n');
      assert.equal(await readFile(join(root, 'global.npmrc'), 'utf8'), '');
      assert.match(await readFile(pathFile, 'utf8'), /lab-01-npm-bootstrap\/toolchain\/bin\n$/);
    }

    const rerun = runs[0];
    assert.equal((await bootstrapNpm({ repoRoot: process.cwd(), ...rerun, npmRunner })).version, '11.18.0');
    assert.equal((await readFile(rerun.pathFile, 'utf8')).trim().split('\n').length, 2);
    assert.equal(calls.length, 66);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(parent, { recursive: true, force: true });
  }
  await assert.rejects(readFile(parent), /ENOENT|EISDIR/);
});

test('all trusted release controllers bootstrap closed npm before any npm command and retain evidence', async () => {
  for (const name of ['ready-release-qa-controller.yml', 'prepare-release-snapshot.yml', 'publish-npm.yml']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.match(workflow, /scripts\/bootstrap-npm-cli\.mjs/);
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf('bootstrap-npm-cli.mjs')), /^\s+npm(?:@|\s)/m);
    assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@[0-9a-f]{40} # v6/);
    assert.match(workflow, /if-no-files-found: warn/);
  }
});

test('publish workflow executes only exact default-main trusted code under minimal OIDC authority', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:|staged publishing/i);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /EXPECTED_DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /EXPECTED_WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(workflow, /checkout[\s\S]{0,300}(?:release-snapshots|releases\/v1\.0|staged\/v1\.0)/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /permissions:\n      contents: read\n      id-token: write/);
  assert.doesNotMatch(workflow, /contents: write|NPM_TOKEN:|NODE_AUTH_TOKEN:|secrets\./);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v6/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6/);
  assert.match(workflow, /node-version: 24\.18\.0/);
});

test('Ready QA pins every external action and separates trusted controller from candidate data', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ready-release-qa-controller.yml', import.meta.url), 'utf8');
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v6/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v6/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.doesNotMatch(workflow, /path: candidate|ref: releases\/v1\.0|ref: staged\/v1\.0/);
  assert.match(workflow, /node scripts\/qa-ready-release\.mjs/);
  assert.match(workflow, /persist-credentials: false/);
});

test('checked-in workflows contain no traditional npm credential or auth configuration', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    const workflow = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(workflow, /secrets\.(?:NPM|NODE_AUTH)|_authToken\s*=|NODE_AUTH_TOKEN:\s|NPM_TOKEN:\s/);
  }
  assert.equal(SNAPSHOT_REF, 'refs/heads/release-snapshots/v1.0.1');
});

test('every write-capable workflow executes only pinned default-main code and every moving-ref workflow is a trivial signal', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const movingSignals = new Set([
    'maintain-release-draft.yml',
    'ready-release-qa.yml',
    'regenerate-release-draft.yml',
  ]);
  for (const name of await readdir(directory)) {
    const workflow = await readFile(new URL(name, directory), 'utf8');
    const writes = /(?:actions|contents|pull-requests|id-token): write/.test(workflow);
    if (movingSignals.has(name)) {
      assert.match(workflow, /^permissions: \{\}$/m, name);
      assert.doesNotMatch(workflow, /\buses:|node scripts|npm\s|contents: write|pull-requests: write|actions: write|id-token: write/, name);
    }
    if (writes) {
      assert.doesNotMatch(workflow, /ref: (?:releases\/v1\.0|staged\/v1\.0|release-snapshots\/|\$\{\{ github\.event\.pull_request)/, name);
      for (const line of workflow.split('\n').filter((value) => value.trim().startsWith('uses:'))) {
        assert.match(line, /@[0-9a-f]{40}(?: # v6)?$/, `${name}: ${line}`);
      }
    }
  }
});
