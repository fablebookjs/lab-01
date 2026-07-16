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
const remoteRoot = join(root, 'remote.git');
const metaPath = join(root, 'release-meta.json');
const lateShaPath = join(root, 'late-sha');
const hang = process.env.LAB_SIGNAL_HANG ?? '';

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
git(repositoryRoot, ['update-ref', `refs/heads/${RELEASE_LINE}`, mergeSha]);
git(repositoryRoot, ['update-ref', SNAPSHOT_REF, snapshotSha]);
git(repositoryRoot, ['update-ref', 'refs/heads/main', sourceSha]);
await rm(remoteRoot, { recursive: true, force: true });
git(root, ['clone', '--quiet', '--bare', repositoryRoot, remoteRoot]);
await writeFile(metaPath, `${JSON.stringify({ mergeSha, snapshotSha })}\n`);

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

let queryCount = 0;
async function hangQuery() {
  await writeFile(markerPath, 'query-started\n');
  return new Promise(() => {});
}
const npmAdapter = {
  async query(spec) {
    queryCount += 1;
    if (
      (hang === 'initial' && queryCount === 1) ||
      (hang === 'ambiguous' && queryCount === 3) ||
      (hang === 'durable' && queryCount === 4)
    ) return hangQuery();
    const observed = JSON.parse(await readFile(statePath, 'utf8'))[spec.name];
    return observed ?? { status: 'absent', name: spec.name };
  },
  async publish(artifact, env, neutralDirectory, interruption) {
    const child = new URL('./publish-signal-child.mjs', import.meta.url);
    const childMode = ['ambiguous', 'durable'].includes(hang) ? 'fail-fast' : mode;
    const childMarker = childMode === mode && mode !== 'early-leader-descendant-ignore' ? markerPath : `${markerPath}.child`;
    await interruption.run(process.execPath, [child.pathname, statePath, childMarker, descendantPath, Buffer.from(JSON.stringify(artifact)).toString('base64url'), childMode], {
      cwd: neutralDirectory,
      env,
      errorCode: `NPM_PUBLISH_FAILED_${artifact.choice.toUpperCase()}`,
    });
    if (mode === 'early-leader-descendant-ignore') {
      await writeFile(markerPath, 'leader-exited\n');
      const keepAlive = setInterval(() => {}, 1_000);
      try { await interruption.whenInterrupted; } finally { clearInterval(keepAlive); }
      interruption.checkpoint();
    }
  },
};

function refAdapter(_repo, ref) {
  try {
    const output = git(repositoryRoot, ['ls-remote', '--refs', '--exit-code', remoteRoot, ref]);
    const [sha, observed] = output.split(/\s+/);
    return observed === ref ? sha : null;
  } catch { return null; }
}

function fetchAdapter(repo, shas) {
  let lateSha = null;
  try { lateSha = execFileSync('cat', [lateShaPath], { encoding: 'utf8' }).trim(); } catch { /* No late line yet. */ }
  if (process.env.LAB_SIGNAL_FETCH_FAIL === '1' && lateSha && shas.includes(lateSha)) throw new Error('raw test fetch failure');
  git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', remoteRoot, ...shas]);
}

Object.assign(process.env, {
  EXPECTED_DISPATCH_SHA: sourceSha,
  EXPECTED_WORKFLOW_SHA: sourceSha,
  GITHUB_REF: 'refs/heads/main',
});

await runPublisherCli({
  argv: ['--repository', REPOSITORY, '--package', choice, '--evidence', evidencePath],
  repoRoot: repositoryRoot,
  npmAdapter,
  refAdapter,
  fetchAdapter,
  temporaryBase,
  oidc: false,
  graceMs: 250,
  durableReadTimeoutMs: 500,
  publicationReadTimeoutMs: 500,
});
