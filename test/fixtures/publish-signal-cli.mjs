import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runPublisherCli } from '../../scripts/publish-npm.mjs';
import {
  PACKAGE_SPECS,
  RELEASE_LINE,
  REPOSITORY,
  SNAPSHOT_REF,
  buildSnapshotMessage,
  closedGitEnvironment,
  createClosedNpmEnvironment,
  materializeInertPackages,
  packPackages,
  packageEvidence,
  reconstructExpectedSnapshot,
} from '../../scripts/release-publication.mjs';

const root = process.env.LAB_SIGNAL_ROOT;
const choice = process.env.LAB_SIGNAL_CHOICE;
const mode = process.env.LAB_SIGNAL_MODE;
const statePath = process.env.LAB_SIGNAL_STATE;
const evidencePath = process.env.LAB_SIGNAL_EVIDENCE;
const markerPath = process.env.LAB_SIGNAL_MARKER;
const descendantPath = process.env.LAB_SIGNAL_DESCENDANT;
const repositoryRoot = join(root, 'repository');
const temporaryBase = join(root, 'publisher-temporary');

function git(cwd, args, options = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...closedGitEnvironment(),
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
    ...options,
  }).trim();
}

await mkdir(temporaryBase, { recursive: true });
await rm(repositoryRoot, { recursive: true, force: true });
git(root, ['clone', '--quiet', '--no-local', process.cwd(), repositoryRoot]);
git(repositoryRoot, ['remote', 'set-url', 'origin', 'https://github.com/fablebookjs/lab-01.git']);
const sourceSha = git(repositoryRoot, ['rev-parse', 'HEAD']);
const sourceTree = git(repositoryRoot, ['rev-parse', `${sourceSha}^{tree}`]);
const intentMessage = `release: propose v1.0.1\n\nRelease-Intent-Version: 1\nRelease-Line: releases/v1.0\nRelease-Version: 1.0.1\nRelease-Source: ${sourceSha}\n`;
const stagedSha = git(repositoryRoot, ['commit-tree', sourceTree, '-p', sourceSha], { input: intentMessage });
const mergeSha = git(repositoryRoot, ['commit-tree', sourceTree, '-p', sourceSha, '-p', stagedSha, '-m', 'merge release intent']);
const preparation = await mkdtemp(join(root, 'prepare-'));
const expected = reconstructExpectedSnapshot(repositoryRoot, mergeSha, join(preparation, 'index'));
const inert = join(preparation, 'inert');
await materializeInertPackages(repositoryRoot, expected.tree, inert);
const npmEnvironment = await createClosedNpmEnvironment(join(preparation, 'npm'));
const packed = await packPackages(inert, join(preparation, 'packs'), npmEnvironment);
const identities = packageEvidence(packed);
const message = buildSnapshotMessage({ mergeSha, stagedSha, sourceSha, tree: expected.tree, contentSha256: expected.contentSha256, packages: identities });
const snapshotSha = git(repositoryRoot, ['commit-tree', expected.tree, '-p', mergeSha], { input: message });
await rm(preparation, { recursive: true, force: true });

let state = {};
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* First dispatch starts absent. */ }
if (choice === 'addon' && !state[PACKAGE_SPECS[0].name]) {
  state[PACKAGE_SPECS[0].name] = {
    status: 'present', name: PACKAGE_SPECS[0].name, version: '1.0.1',
    integrity: identities[0].integrity, shasum: identities[0].shasum,
    repository: { type: 'git', url: 'git+https://github.com/fablebookjs/lab-01.git', directory: PACKAGE_SPECS[0].directory },
  };
}
await writeFile(statePath, `${JSON.stringify(state)}\n`);

const refs = new Map([
  ['refs/heads/main', sourceSha],
  [`refs/heads/${RELEASE_LINE}`, mergeSha],
  [SNAPSHOT_REF, snapshotSha],
]);
const npmAdapter = {
  async query(spec) {
    const observed = JSON.parse(await readFile(statePath, 'utf8'))[spec.name];
    return observed ?? { status: 'absent', name: spec.name };
  },
  async publish(artifact, env, neutralDirectory, interruption) {
    const child = new URL('./publish-signal-child.mjs', import.meta.url);
    await interruption.run(process.execPath, [child.pathname, statePath, markerPath, descendantPath, Buffer.from(JSON.stringify(artifact)).toString('base64url'), mode], {
      cwd: neutralDirectory,
      env,
      errorCode: `NPM_PUBLISH_FAILED_${artifact.choice.toUpperCase()}`,
    });
  },
};

Object.assign(process.env, {
  EXPECTED_DISPATCH_SHA: sourceSha,
  EXPECTED_WORKFLOW_SHA: sourceSha,
  GITHUB_REF: 'refs/heads/main',
});

await runPublisherCli({
  argv: ['--repository', REPOSITORY, '--package', choice, '--evidence', evidencePath],
  repoRoot: repositoryRoot,
  npmAdapter,
  refAdapter: (_repo, ref) => refs.get(ref) ?? null,
  fetchAdapter: () => {},
  temporaryBase,
  oidc: false,
  graceMs: 250,
  durableReadTimeoutMs: 500,
});
