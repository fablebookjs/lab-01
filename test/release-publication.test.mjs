import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';

import {
  assertTrustedPreparationMain,
  ensureSnapshotRef,
  retainedArtifactAvailable,
  validateLatestMergedAuthority,
} from '../scripts/prepare-release-snapshot.mjs';
import {
  applyPublicationState,
  assertTrustedMain,
  lineRelation,
  publishFromSnapshot,
} from '../scripts/publish-npm.mjs';
import {
  PACKAGE_SPECS,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  TRANSFORMED_FILES,
  assertNoAmbientGitConfiguration,
  assertSafeGitConfiguration,
  buildSnapshotMessage,
  command,
  createClosedNpmEnvironment,
  materializeInertPackages,
  parseSnapshotMessage,
  reconstructExpectedSnapshot,
  validateExactSnapshotTree,
  validateManifest,
} from '../scripts/release-publication.mjs';
import {
  assertNoAmbientPackageConfiguration,
  assertNoProjectNpmrc,
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
  return { directory, merge: git(directory, 'rev-parse', 'HEAD') };
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
    merged: true,
    merged_at: '2026-07-15T10:00:00Z',
    base: { repo: { full_name: REPOSITORY }, ref: RELEASE_LINE, sha: sourceSha },
    head: { repo: { full_name: REPOSITORY }, ref: 'staged/v1.0', sha: stagedSha },
    merge_commit_sha: mergeSha,
  };
  return {
    pull,
    pulls: [structuredClone(pull)],
    runs: {
      workflow_runs: [
        { id: 98, created_at: '2026-07-15T10:01:00Z', status: 'completed', conclusion: 'success', path: '.github/workflows/ready-release-qa.yml', head_sha: stagedSha, event: 'pull_request' },
        { id: 99, created_at: '2026-07-15T10:02:00Z', status: 'completed', conclusion: 'success', path: '.github/workflows/ready-release-qa.yml', head_sha: stagedSha, event: 'workflow_dispatch' },
      ],
    },
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
  wrongHead.runs.workflow_runs.forEach((run) => { run.head_sha = sourceSha; });
  assert.throws(() => validateLatestMergedAuthority(wrongHead), /CURRENT_READY_QA_AUTHORIZATION_MISSING/);
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

test('all release workflows bootstrap closed npm before any npm command and retain evidence', async () => {
  for (const name of ['ready-release-qa.yml', 'prepare-release-snapshot.yml', 'publish-npm.yml']) {
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
  const workflow = await readFile(new URL('../.github/workflows/ready-release-qa.yml', import.meta.url), 'utf8');
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v7/g);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40} # v6/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v6/);
  assert.match(workflow, /ref: releases\/v1\.0\n          path: trusted/);
  assert.match(workflow, /path: candidate/);
  assert.match(workflow, /node \.\.\/trusted\/scripts\/qa-ready-release\.mjs/);
  assert.match(workflow, /persist-credentials: false/g);
});

test('checked-in workflows contain no traditional npm credential or auth configuration', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    const workflow = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(workflow, /secrets\.(?:NPM|NODE_AUTH)|_authToken\s*=|NODE_AUTH_TOKEN:\s|NPM_TOKEN:\s/);
  }
  assert.equal(SNAPSHOT_REF, 'refs/heads/release-snapshots/v1.0.1');
});
