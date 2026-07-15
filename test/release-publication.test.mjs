import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureSnapshotRef, validateMergedAuthority } from '../scripts/prepare-release-snapshot.mjs';
import { applyPublicationState } from '../scripts/publish-npm.mjs';
import {
  PACKAGE_SPECS,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  TRANSFORMED_FILES,
  buildSnapshotMessage,
  createClosedNpmEnvironment,
  parseSnapshotMessage,
  validateIntentShape,
  validateMergeShape,
  validateQaEvidence,
  validateSnapshotShape,
} from '../scripts/release-publication.mjs';

const sha = (value) => value.repeat(40);
const sourceSha = sha('1');
const stagedSha = sha('2');
const mergeSha = sha('3');
const snapshotSha = sha('4');
const sourceTree = sha('5');
const transformedTree = sha('6');
const integrities = [
  `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
];
const packages = PACKAGE_SPECS.map((spec, index) => ({
  name: spec.name,
  integrity: integrities[index],
  shasum: String(index + 1).repeat(40),
}));

function intent() {
  return {
    sha: stagedSha,
    parents: [sourceSha],
    tree: sourceTree,
    sourceTree,
    message: `release: propose v1.0.1\n\nRelease-Intent-Version: 1\nRelease-Line: releases/v1.0\nRelease-Version: 1.0.1\nRelease-Source: ${sourceSha}\n`,
  };
}

function qaEvidence() {
  return {
    schemaVersion: 2,
    repository: REPOSITORY,
    authority: {
      mode: 'github-current',
      githubCurrent: true,
      repository: REPOSITORY,
      refs: {
        staged: { name: 'staged/v1.0', sha: stagedSha },
        source: { name: RELEASE_LINE, sha: sourceSha },
      },
      pullRequest: {
        number: 12,
        state: 'open',
        draft: false,
        head: { repository: REPOSITORY, ref: 'staged/v1.0', sha: stagedSha },
        base: { repository: REPOSITORY, ref: RELEASE_LINE, sha: sourceSha },
      },
    },
    release: {
      version: RELEASE_VERSION,
      stagedSha,
      sourceSha,
      sourceTree,
      transformedTree,
      transformedContentSha256: 'a'.repeat(64),
    },
    transformation: {
      files: [...TRANSFORMED_FILES],
      packageNames: PACKAGE_SPECS.map(({ name }) => name),
      addonCoreDependency: RELEASE_VERSION,
    },
    registry: { packages: structuredClone(packages) },
    consumer: { result: 'passed' },
  };
}

function authorityFixture() {
  const pull = {
      number: 12,
      state: 'closed',
      merged: true,
      base: { repo: { full_name: REPOSITORY }, ref: RELEASE_LINE, sha: sourceSha },
      head: { repo: { full_name: REPOSITORY }, ref: 'staged/v1.0', sha: stagedSha },
      merge_commit_sha: mergeSha,
    };
  return {
    pull,
    pulls: [structuredClone(pull)],
    run: {
      id: 99,
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/ready-release-qa.yml',
      head_sha: stagedSha,
      event: 'pull_request',
    },
    artifacts: {
      total_count: 1,
      artifacts: [{ id: 7, name: `ready-release-qa-${stagedSha}`, expired: false }],
    },
    prNumber: '12',
    qaRunId: '99',
  };
}

test('accepted M and V graph shapes require ordered distinct release roles', () => {
  const source = { sha: sourceSha, tree: sourceTree };
  const staged = intent();
  const merge = { sha: mergeSha, tree: sourceTree, parents: [sourceSha, stagedSha] };
  const message = buildSnapshotMessage({ mergeSha, qaRunId: 99, stagedSha, sourceSha, packages });
  const metadata = parseSnapshotMessage(message);
  const snapshot = { sha: snapshotSha, tree: transformedTree, parents: [mergeSha] };
  assert.doesNotThrow(() => validateIntentShape(staged, sourceSha));
  assert.doesNotThrow(() => validateMergeShape(merge, source, staged));
  assert.doesNotThrow(() => validateSnapshotShape(snapshot, metadata, merge));

  assert.throws(() => validateMergeShape({ ...merge, parents: [stagedSha, sourceSha] }, source, staged), /ordered/);
  assert.throws(() => validateSnapshotShape({ ...snapshot, parents: [sourceSha] }, metadata, merge), /one-parent/);
  assert.throws(() => validateSnapshotShape({ ...snapshot, tree: sourceTree }, metadata, merge), /transformed/);
  assert.throws(() => validateIntentShape({ ...staged, tree: transformedTree }, sourceSha), /not empty/);
});

test('snapshot authority rejects wrong PR, run, and artifact identities', () => {
  const fixture = authorityFixture();
  assert.equal(validateMergedAuthority(fixture).mergeSha, mergeSha);
  const attacks = [
    (value) => (value.pull.merged = false),
    (value) => (value.pull.head.ref = 'other'),
    (value) => (value.run.conclusion = 'failure'),
    (value) => (value.run.head_sha = sourceSha),
    (value) => value.pulls.push(structuredClone(value.pulls[0])),
    (value) => value.artifacts.artifacts.push(structuredClone(value.artifacts.artifacts[0])),
    (value) => (value.artifacts.artifacts[0].expired = true),
  ];
  for (const attack of attacks) {
    const value = structuredClone(fixture);
    attack(value);
    assert.throws(() => validateMergedAuthority(value));
  }
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
          if (ambiguous) throw new Error('lost ref success response');
        },
      },
    };
  }
  const created = harness();
  assert.equal(await ensureSnapshotRef({ adapter: created.adapter, repoRoot: '/mock', snapshotSha }), 'created');
  assert.deepEqual(created.writes, [snapshotSha]);

  const reused = harness({ initial: snapshotSha });
  assert.equal(await ensureSnapshotRef({ adapter: reused.adapter, repoRoot: '/mock', snapshotSha }), 'reused');
  assert.deepEqual(reused.writes, []);

  const ambiguous = harness({ ambiguous: true });
  assert.equal(
    await ensureSnapshotRef({ adapter: ambiguous.adapter, repoRoot: '/mock', snapshotSha }),
    'created-after-ambiguous-response',
  );
  await assert.rejects(
    ensureSnapshotRef({ adapter: harness({ initial: sourceSha }).adapter, repoRoot: '/mock', snapshotSha }),
    /incompatible/,
  );
});

test('QA evidence binds exact source, transformed tree, package order and hashes', () => {
  const expected = validateQaEvidence(qaEvidence(), { stagedSha, sourceSha, qaRunId: 99, prNumber: 12 });
  assert.equal(expected.transformedTree, transformedTree);
  const attacks = [
    (value) => (value.release.transformedTree = sourceTree),
    (value) => (value.authority.githubCurrent = false),
    (value) => value.transformation.files.pop(),
    (value) => value.registry.packages.reverse(),
    (value) => (value.registry.packages[0].integrity = 'wrong'),
    (value) => (value.consumer.result = 'failed'),
  ];
  for (const attack of attacks) {
    const value = qaEvidence();
    attack(value);
    assert.throws(() => validateQaEvidence(value, { stagedSha, sourceSha, qaRunId: 99, prNumber: 12 }));
  }
});

function present(artifact) {
  const spec = PACKAGE_SPECS.find(({ name }) => name === artifact.name);
  return {
    status: 'present',
    name: artifact.name,
    version: RELEASE_VERSION,
    repository: { type: 'git', url: REPOSITORY_URL, directory: spec.directory },
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    tarball: `https://registry.npmjs.org/${artifact.name}/-/${spec.choice}.tgz`,
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
        if (ambiguous) throw new Error('lost success response');
      },
    },
  };
}

test('core-first publication, partial continuation, and reruns converge', async () => {
  const artifacts = packages.map((item) => ({ ...item, tarball: `/tmp/${item.name}.tgz` }));
  const absent = PACKAGE_SPECS.map(({ name }) => ({ status: 'absent', name }));
  const first = publicationHarness(absent);
  assert.equal((await applyPublicationState({ choice: 'core', artifacts, adapter: first.adapter, npmEnvironment: {} })).result, 'published-and-verified');
  assert.deepEqual(first.publishes, [PACKAGE_SPECS[0].name]);

  const continuation = publicationHarness([present(artifacts[0]), absent[1]]);
  assert.equal((await applyPublicationState({ choice: 'addon', artifacts, adapter: continuation.adapter, npmEnvironment: {} })).result, 'published-and-verified');
  assert.deepEqual(continuation.publishes, [PACKAGE_SPECS[1].name]);

  const rerun = publicationHarness([present(artifacts[0]), present(artifacts[1])]);
  assert.equal((await applyPublicationState({ choice: 'addon', artifacts, adapter: rerun.adapter, npmEnvironment: {} })).result, 'reused');
  assert.deepEqual(rerun.publishes, []);
});

test('publisher rejects wrong order and incompatible npm state permanently', async () => {
  const artifacts = packages.map((item) => ({ ...item, tarball: `/tmp/${item.name}.tgz` }));
  const absent = PACKAGE_SPECS.map(({ name }) => ({ status: 'absent', name }));
  await assert.rejects(
    applyPublicationState({ choice: 'addon', artifacts, adapter: publicationHarness(absent).adapter, npmEnvironment: {} }),
    /blocked until exact matching core/,
  );
  const mismatch = present(artifacts[0]);
  mismatch.integrity = integrities[1];
  await assert.rejects(
    applyPublicationState({ choice: 'core', artifacts, adapter: publicationHarness([mismatch, absent[1]]).adapter, npmEnvironment: {} }),
    /PERMANENT STOP/,
  );
  const wrongRepository = present(artifacts[0]);
  wrongRepository.repository.url = 'git+https://github.com/other/repo.git';
  await assert.rejects(
    applyPublicationState({ choice: 'core', artifacts, adapter: publicationHarness([wrongRepository, absent[1]]).adapter, npmEnvironment: {} }),
    /incompatible repository/,
  );
});

test('lost publish success is accepted only after exact registry readback', async () => {
  const artifacts = packages.map((item) => ({ ...item, tarball: `/tmp/${item.name}.tgz` }));
  const absent = PACKAGE_SPECS.map(({ name }) => ({ status: 'absent', name }));
  const harness = publicationHarness(absent, { ambiguous: true });
  const result = await applyPublicationState({ choice: 'core', artifacts, adapter: harness.adapter, npmEnvironment: {} });
  assert.equal(result.result, 'published-after-ambiguous-response');
});

test('closed npm environment ignores ambient config, registries, tokens and provenance attacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-01-publish-env-'));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      NPM_TOKEN: 'ambient-token',
      NODE_AUTH_TOKEN: 'ambient-token',
      NPM_CONFIG_REGISTRY: 'https://attacker.invalid/',
      NPM_CONFIG_PROVENANCE: 'false',
      NPM_CONFIG_USERCONFIG: '/tmp/attacker-npmrc',
    });
    const env = await createClosedNpmEnvironment(directory);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/');
    assert.equal(env.NPM_CONFIG_PROVENANCE, 'true');
    const config = await readFile(env.NPM_CONFIG_USERCONFIG, 'utf8');
    assert.match(config, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
    assert.match(config, /^provenance=true$/m);
    assert.doesNotMatch(config, /token|attacker|provenance=false/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('OIDC environment retains only the exact GitHub-hosted publisher identity inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-01-oidc-env-'));
  const previous = { ...process.env };
  const required = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-request-token',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/releases/v1.0',
    GITHUB_REF_NAME: 'releases/v1.0',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '2',
    GITHUB_RUN_NUMBER: '3',
    GITHUB_SHA: snapshotSha,
    GITHUB_WORKFLOW: 'Publish npm package',
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/releases/v1.0`,
    GITHUB_WORKFLOW_SHA: snapshotSha,
    RUNNER_ENVIRONMENT: 'github-hosted',
  };
  try {
    Object.assign(process.env, required, { NPM_TOKEN: 'ambient', NODE_AUTH_TOKEN: 'ambient' });
    const env = await createClosedNpmEnvironment(directory, { oidc: true });
    for (const [key, value] of Object.entries(required)) assert.equal(env[key], value);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.equal(env.NODE_AUTH_TOKEN, undefined);
    process.env.RUNNER_ENVIRONMENT = 'self-hosted';
    await assert.rejects(createClosedNpmEnvironment(join(directory, 'bad'), { oidc: true }), /incompatible/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});

test('publishable tarballs contain only package.json and src/index.js', () => {
  for (const spec of PACKAGE_SPECS) {
    const output = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', `./${spec.directory}`], { encoding: 'utf8' }));
    assert.deepEqual(output[0].files.map(({ path }) => path).sort(), ['package.json', 'src/index.js']);
  }
});

test('workflow structures keep snapshot writes separate from tokenless OIDC publication', async () => {
  const [snapshotWorkflow, publishWorkflow] = await Promise.all([
    readFile(new URL('../.github/workflows/prepare-release-snapshot.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(snapshotWorkflow, /workflow_dispatch:/);
  assert.match(snapshotWorkflow, /contents: write/);
  assert.match(snapshotWorkflow, /actions: read/);
  assert.match(snapshotWorkflow, /pull-requests: read/);
  assert.match(snapshotWorkflow, /refs\/heads\/releases\/v1\.0|refs\/heads\/releases\/v1\.0/);

  assert.match(publishWorkflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(publishWorkflow, /pull_request:|push:|schedule:/);
  assert.match(publishWorkflow, /runs-on: ubuntu-24\.04/);
  assert.match(publishWorkflow, /github\.ref == 'refs\/heads\/releases\/v1\.0'/);
  assert.match(publishWorkflow, /environment: npm-publish/);
  assert.match(publishWorkflow, /permissions:\n      contents: read\n      id-token: write/);
  assert.doesNotMatch(publishWorkflow, /contents: write|pull-requests:|actions: (?:read|write)/);
  assert.match(publishWorkflow, /actions\/checkout@[0-9a-f]{40} # v6/);
  assert.match(publishWorkflow, /actions\/setup-node@[0-9a-f]{40} # v6/);
  assert.match(publishWorkflow, /node-version: 24\.18\.0/);
  assert.match(publishWorkflow, /npm@11\.18\.0/);
  assert.doesNotMatch(publishWorkflow, /NPM_TOKEN:|NODE_AUTH_TOKEN:|secrets\./);
});

test('checked-in workflows contain no traditional npm credential or auth configuration', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    const workflow = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotMatch(workflow, /secrets\.(?:NPM|NODE_AUTH)|_authToken\s*=|NODE_AUTH_TOKEN:\s|NPM_TOKEN:\s/);
  }
});
