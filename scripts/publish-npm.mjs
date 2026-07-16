import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  PACKAGE_SPECS,
  REGISTRY,
  RELEASE_LINE,
  RELEASE_VERSION,
  REPOSITORY,
  REPOSITORY_URL,
  SNAPSHOT_REF,
  assertNoTrackedNpmConfiguration,
  assertPinnedNpmVersion,
  assertSafeGitConfiguration,
  assertSha,
  closedGitEnvironment,
  commitShape,
  fail,
  git,
  materializeInertPackages,
  packPackages,
  packageEvidence,
  parseSnapshotMessage,
  reconstructExpectedSnapshot,
  sanitizedEvidence,
  validateExactSnapshotTree,
  validateIntentShape,
  validateMergeShape,
  validateSnapshotShape,
} from './release-publication.mjs';

function remoteRef(repoRoot, ref) {
  try {
    const output = execFileSync('git', ['--no-replace-objects', 'ls-remote', '--refs', '--exit-code', 'origin', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: closedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = output.split('\n').filter(Boolean);
    if (rows.length !== 1) fail('REMOTE_REF_AMBIGUOUS');
    const [sha, observedRef] = rows[0].split(/\s+/);
    assertSha(sha, 'remote ref');
    if (observedRef !== ref) fail('REMOTE_REF_IDENTITY_INVALID');
    return sha;
  } catch (error) {
    if (error.status === 2) return null;
    fail('REMOTE_REF_READ_FAILED');
  }
}

function fetchObjects(repoRoot, shas) {
  try {
    execFileSync('git', ['--no-replace-objects', 'fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...shas], {
      cwd: repoRoot,
      env: closedGitEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    fail('RELEASE_OBJECT_FETCH_FAILED');
  }
}

function repositoryMatches(repository, directory) {
  return repository?.type === 'git' && repository.url === REPOSITORY_URL && repository.directory === directory;
}

async function fetchRegistryPackage(spec, { signal } = {}) {
  let response;
  try {
    response = await fetch(new URL(`/${encodeURIComponent(spec.name)}/${RELEASE_VERSION}`, REGISTRY), { headers: { Accept: 'application/json' }, signal });
  } catch { fail(`NPM_QUERY_FAILED_${spec.choice.toUpperCase()}`); }
  if (response.status === 404) return { status: 'absent', name: spec.name };
  if (!response.ok) fail(`NPM_QUERY_FAILED_${spec.choice.toUpperCase()}`);
  let metadata;
  try { metadata = await response.json(); } catch { fail(`NPM_METADATA_INVALID_${spec.choice.toUpperCase()}`); }
  if (
    metadata.name !== spec.name || metadata.version !== RELEASE_VERSION ||
    !repositoryMatches(metadata.repository, spec.directory) ||
    typeof metadata.dist?.integrity !== 'string' || typeof metadata.dist?.shasum !== 'string' || typeof metadata.dist?.tarball !== 'string'
  ) fail(`NPM_METADATA_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  const archiveName = `${spec.name.slice(spec.name.indexOf('/') + 1)}-${RELEASE_VERSION}.tgz`;
  const expectedTarball = new URL(`/${spec.name}/-/${archiveName}`, REGISTRY);
  if (metadata.dist.tarball !== expectedTarball.href) fail(`NPM_TARBALL_URL_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  let tarballResponse;
  try { tarballResponse = await fetch(expectedTarball, { signal }); } catch { fail(`NPM_TARBALL_READ_FAILED_${spec.choice.toUpperCase()}`); }
  if (!tarballResponse.ok) fail(`NPM_TARBALL_READ_FAILED_${spec.choice.toUpperCase()}`);
  const bytes = Buffer.from(await tarballResponse.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (integrity !== metadata.dist.integrity || shasum !== metadata.dist.shasum) fail(`NPM_TARBALL_BYTES_INCOMPATIBLE_${spec.choice.toUpperCase()}`);
  return { status: 'present', name: spec.name, version: metadata.version, repository: metadata.repository, integrity, shasum, tarball: expectedTarball.href };
}

export const liveNpmAdapter = {
  query: fetchRegistryPackage,
  async publish(artifact, env, neutralDirectory, interruption) {
    await interruption.run('npm', [
      'publish', artifact.tarball, '--access', 'public', '--ignore-scripts', '--provenance', '--registry', REGISTRY,
    ], { cwd: neutralDirectory, env, errorCode: `NPM_PUBLISH_FAILED_${artifact.choice.toUpperCase()}` });
  },
};

function interruptionError(signal) {
  const error = new Error('PUBLISH_INTERRUPTED');
  error.code = 'PUBLISH_INTERRUPTED';
  Object.defineProperty(error, 'signal', { value: signal, enumerable: false });
  return error;
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export function createInterruptionLifecycle({ graceMs = 2_000 } = {}) {
  let signal = null;
  let active = null;
  let group = null;
  let termination = Promise.resolve();
  let resolveInterrupted;
  const interrupted = new Promise((resolvePromise) => { resolveInterrupted = resolvePromise; });
  const abortControllers = new Set();
  const child = { started: false, forwarded: false, escalated: false, leaderSettled: true, groupSettled: true, settled: true };

  function send(target, requested) {
    try {
      if (process.platform !== 'win32' && target.pid) process.kill(-target.pid, requested);
      else target.process.kill(requested);
      return true;
    } catch {
      return false;
    }
  }

  function groupExists(target) {
    if (process.platform === 'win32' || !target?.pid) return target?.process.exitCode === null && target?.process.signalCode === null;
    try {
      process.kill(-target.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      return true;
    }
  }

  async function awaitGroupExtinction(target, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (groupExists(target) && Date.now() < deadline) await wait(20);
    return !groupExists(target);
  }

  async function terminateActive() {
    const target = group ?? active;
    if (!target) return;
    child.forwarded = send(target, signal);
    child.groupSettled = await awaitGroupExtinction(target, graceMs);
    if (!child.groupSettled) {
      child.escalated = send(target, 'SIGKILL');
      child.groupSettled = await awaitGroupExtinction(target, graceMs);
    }
    await target.closed;
    child.leaderSettled = true;
    child.settled = child.leaderSettled && child.groupSettled;
  }

  return {
    get signal() { return signal; },
    get child() { return { ...child }; },
    get whenInterrupted() { return interrupted; },
    registerAbortController(controller) { abortControllers.add(controller); },
    unregisterAbortController(controller) { abortControllers.delete(controller); },
    interrupt(requested) {
      if (!['SIGINT', 'SIGTERM'].includes(requested) || signal) return termination;
      signal = requested;
      for (const controller of abortControllers) controller.abort();
      resolveInterrupted(signal);
      termination = terminateActive();
      return termination;
    },
    checkpoint() {
      if (signal) throw interruptionError(signal);
    },
    async settle() {
      await termination;
      if (active) await active.closed;
    },
    async run(file, args, options = {}) {
      this.checkpoint();
      let subprocess;
      try {
        subprocess = spawn(file, args, {
          cwd: options.cwd,
          env: options.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        fail(options.errorCode ?? 'SUBPROCESS_FAILED');
      }
      child.started = true;
      child.leaderSettled = false;
      child.groupSettled = false;
      child.settled = false;
      subprocess.stdout?.resume();
      subprocess.stderr?.resume();
      let resolveClosed;
      const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise; });
      const target = { process: subprocess, pid: subprocess.pid, closed };
      active = target;
      group = target;
      const completed = new Promise((resolvePromise, rejectPromise) => {
        subprocess.once('error', () => rejectPromise(new Error(options.errorCode ?? 'SUBPROCESS_FAILED')));
        subprocess.once('close', (code, childSignal) => {
          child.leaderSettled = true;
          child.settled = child.leaderSettled && child.groupSettled;
          if (active === target) active = null;
          resolveClosed({ code, signal: childSignal });
          if (signal) rejectPromise(interruptionError(signal));
          else if (code === 0) resolvePromise();
          else rejectPromise(new Error(options.errorCode ?? 'SUBPROCESS_FAILED'));
        });
      });
      if (signal) termination = terminateActive();
      try {
        await completed;
      } catch (error) {
        if (error.code === 'PUBLISH_INTERRUPTED') throw error;
        fail(options.errorCode ?? 'SUBPROCESS_FAILED');
      }
    },
  };
}

function assertMatching(observation, artifact) {
  if (observation.status !== 'present') fail(`NPM_EXPECTED_PRESENT_${artifact.choice.toUpperCase()}`);
  if (observation.integrity !== artifact.integrity || observation.shasum !== artifact.shasum) fail(`NPM_INTEGRITY_INCOMPATIBLE_${artifact.choice.toUpperCase()}`);
  if (!repositoryMatches(observation.repository, artifact.directory)) fail(`NPM_REPOSITORY_INCOMPATIBLE_${artifact.choice.toUpperCase()}`);
}

export async function applyPublicationState({
  choice,
  artifacts,
  adapter,
  npmEnvironment,
  neutralDirectory = tmpdir(),
  interruption = createInterruptionLifecycle(),
  queryTimeoutMs = 5_000,
}) {
  interruption.checkpoint();
  const selectedIndex = PACKAGE_SPECS.findIndex((spec) => spec.choice === choice);
  if (selectedIndex < 0) fail('PACKAGE_CHOICE_INVALID');
  const observations = [];
  for (let index = 0; index < PACKAGE_SPECS.length; index += 1) {
    const observation = await boundedQuery(adapter, PACKAGE_SPECS[index], queryTimeoutMs, interruption);
    observations.push(observation);
    if (observation.status === 'present') assertMatching(observation, artifacts[index]);
  }
  if (observations[0].status === 'absent' && observations[1].status === 'present') fail('NPM_INVERSE_PARTIAL_STATE');
  if (choice === 'addon' && observations[0].status !== 'present') fail('ADDON_BLOCKED_UNTIL_CORE');
  const before = observations[selectedIndex];
  if (before.status === 'present') return { result: 'reused', before, after: before, observations };
  try {
    await adapter.publish(artifacts[selectedIndex], npmEnvironment, neutralDirectory, interruption);
  } catch (error) {
    if (error.code === 'PUBLISH_INTERRUPTED' || interruption.signal) throw interruptionError(interruption.signal ?? error.signal);
    const raced = await boundedQuery(adapter, PACKAGE_SPECS[selectedIndex], queryTimeoutMs, interruption);
    if (raced.status === 'present') {
      assertMatching(raced, artifacts[selectedIndex]);
      return { result: 'published-after-ambiguous-response', before, after: raced, observations };
    }
    throw error;
  }
  const after = await boundedQuery(adapter, PACKAGE_SPECS[selectedIndex], queryTimeoutMs, interruption);
  assertMatching(after, artifacts[selectedIndex]);
  return { result: 'published-and-verified', before, after, observations };
}

function assertAncestor(repoRoot, ancestor, descendant, code) {
  try { execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot, env: closedGitEnvironment(), stdio: 'ignore' }); }
  catch { fail(code); }
}

export function lineRelation(repoRoot, mergeSha, snapshotSha, lineHead) {
  assertAncestor(repoRoot, mergeSha, lineHead, 'RELEASE_LINE_DOES_NOT_CONTAIN_M');
  try {
    execFileSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', snapshotSha, lineHead], { cwd: repoRoot, env: closedGitEnvironment(), stdio: 'ignore' });
    fail('RELEASE_LINE_RECONCILED_BEFORE_PUBLICATION');
  } catch (error) {
    if (error.code === 'RELEASE_LINE_RECONCILED_BEFORE_PUBLICATION') throw error;
  }
  return lineHead === mergeSha ? 'at-merge' : 'late-descendant';
}

function matchesExpected(observation, artifact) {
  return observation.status === 'present' && observation.integrity === artifact.integrity &&
    observation.shasum === artifact.shasum && repositoryMatches(observation.repository, artifact.directory);
}

async function boundedQuery(adapter, spec, milliseconds, interruption) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('NPM_DURABLE_READ_TIMEOUT');
      error.code = 'NPM_DURABLE_READ_TIMEOUT';
      rejectPromise(error);
    }, milliseconds);
  });
  interruption?.registerAbortController(controller);
  const stopped = interruption?.whenInterrupted.then((signal) => { throw interruptionError(signal); });
  try {
    return await Promise.race([
      adapter.query(spec, { signal: controller.signal }),
      timeout,
      ...(stopped ? [stopped] : []),
    ]);
  } finally {
    clearTimeout(timer);
    interruption?.unregisterAbortController(controller);
  }
}

export async function durableNpmState(adapter, artifacts = [], milliseconds = 5_000, interruption) {
  const state = [];
  for (let index = 0; index < PACKAGE_SPECS.length; index += 1) {
    const spec = PACKAGE_SPECS[index];
    try {
      const item = await boundedQuery(adapter, spec, milliseconds, interruption);
      if (item.status === 'absent') state.push({ name: spec.name, status: 'absent' });
      else if (!artifacts[index]) state.push({ name: spec.name, status: 'unknown', code: `NPM_EXPECTED_IDENTITY_UNAVAILABLE_${spec.choice.toUpperCase()}` });
      else if (matchesExpected(item, artifacts[index])) {
        state.push({ name: spec.name, status: 'matching', integrity: item.integrity, shasum: item.shasum, repository: item.repository });
      } else state.push({ name: spec.name, status: 'mismatching', code: `NPM_DURABLE_MISMATCH_${spec.choice.toUpperCase()}` });
    } catch (error) {
      if (error.code === 'PUBLISH_INTERRUPTED') throw error;
      const suffix = spec.choice.toUpperCase();
      state.push({ name: spec.name, status: 'unknown', code: error.code === 'NPM_DURABLE_READ_TIMEOUT' ? `NPM_DURABLE_READ_TIMEOUT_${suffix}` : `NPM_DURABLE_READ_FAILED_${suffix}` });
    }
  }
  return state;
}

export function assertTrustedMain(repoRoot, refAdapter) {
  const local = git(repoRoot, 'rev-parse', 'HEAD');
  const remote = refAdapter(repoRoot, 'refs/heads/main');
  const dispatch = process.env.EXPECTED_DISPATCH_SHA;
  const workflow = process.env.EXPECTED_WORKFLOW_SHA;
  if (local !== remote || dispatch !== remote || workflow !== remote || process.env.GITHUB_REF !== 'refs/heads/main') {
    fail('TRUSTED_MAIN_IDENTITY_MISMATCH');
  }
  return remote;
}

export async function publishFromSnapshot({
  repoRoot,
  choice,
  evidencePath,
  npmAdapter = liveNpmAdapter,
  refAdapter = remoteRef,
  fetchAdapter = fetchObjects,
  temporaryBase = tmpdir(),
  oidc = true,
  interruption = createInterruptionLifecycle(),
  durableReadTimeoutMs = 5_000,
  publicationReadTimeoutMs = 5_000,
}) {
  const evidence = {
    schemaVersion: 2,
    operation: 'publish-npm',
    repository: REPOSITORY,
    choice,
    status: 'started',
    npm: { durable: [] },
    error: null,
    interruption: null,
    restart: { required: false, reason: null },
    cleanup: { temporary: 'not-created', code: null },
    safety: { trustedMain: null, candidateExecuted: false, traditionalToken: false, reconciliationMutation: false, tagMutation: false, githubReleaseMutation: false },
  };
  let temporary;
  let packed = [];
  let thrown;
  try {
    interruption.checkpoint();
    assertSafeGitConfiguration(repoRoot);
    if (git(repoRoot, 'status', '--porcelain') !== '') fail('PUBLISHER_WORKTREE_DIRTY');
    if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) fail('TRADITIONAL_NPM_TOKEN_PROHIBITED');
    evidence.safety.trustedMain = assertTrustedMain(repoRoot, refAdapter);
    temporary = await mkdtemp(join(temporaryBase, 'lab-01-publish-'));
    evidence.cleanup.temporary = 'pending';
    const npmEnvironment = await assertPinnedNpmVersion(join(temporary, 'npm'), { oidc });
    const snapshotSha = refAdapter(repoRoot, SNAPSHOT_REF);
    const lineBefore = refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
    assertSha(snapshotSha, 'snapshot ref');
    assertSha(lineBefore, 'release line');
    fetchAdapter(repoRoot, [snapshotSha, lineBefore]);
    const snapshotMessage = commitShape(repoRoot, snapshotSha).message;
    const metadata = parseSnapshotMessage(snapshotMessage);
    fetchAdapter(repoRoot, [metadata.mergeSha, metadata.stagedSha, metadata.sourceSha]);
    const merge = commitShape(repoRoot, metadata.mergeSha);
    const source = commitShape(repoRoot, metadata.sourceSha);
    const intent = commitShape(repoRoot, metadata.stagedSha);
    intent.sourceTree = source.tree;
    validateIntentShape(intent, source.sha);
    validateMergeShape(merge, source, intent);
    assertNoTrackedNpmConfiguration(repoRoot, merge.sha);
    const expected = reconstructExpectedSnapshot(repoRoot, merge.sha, join(temporary, 'index'));
    const snapshot = validateExactSnapshotTree(repoRoot, merge.sha, snapshotSha, expected.tree);
    validateSnapshotShape(snapshot, metadata, merge);
    if (metadata.contentSha256 !== expected.contentSha256) fail('SNAPSHOT_CONTENT_CROSSCHECK_FAILED');
    evidence.release = { line: RELEASE_LINE, version: RELEASE_VERSION, sourceSha: source.sha, stagedSha: intent.sha, mergeSha: merge.sha };
    evidence.snapshot = { ref: SNAPSHOT_REF, sha: snapshot.sha, tree: expected.tree, parent: merge.sha };
    evidence.line = { before: lineBefore, beforeRelation: lineRelation(repoRoot, merge.sha, snapshot.sha, lineBefore), after: null, afterRelation: null };
    const inert = join(temporary, 'inert');
    await materializeInertPackages(repoRoot, expected.tree, inert);
    packed = await packPackages(inert, join(temporary, 'packs'), npmEnvironment);
    const identities = packageEvidence(packed);
    const reduced = identities.map(({ name, integrity, shasum }) => ({ name, integrity, shasum }));
    if (JSON.stringify(reduced) !== JSON.stringify(metadata.packages)) fail('SNAPSHOT_MESSAGE_HASH_CROSSCHECK_FAILED');
    evidence.snapshot.packages = identities;
    evidence.npm.publication = await applyPublicationState({ choice, artifacts: packed, adapter: npmAdapter, npmEnvironment, neutralDirectory: temporary, interruption, queryTimeoutMs: publicationReadTimeoutMs });
    interruption.checkpoint();
    const lineAfter = refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
    fetchAdapter(repoRoot, [lineAfter]);
    evidence.line.after = lineAfter;
    evidence.line.afterRelation = lineRelation(repoRoot, merge.sha, snapshot.sha, lineAfter);
    evidence.status = 'succeeded';
  } catch (error) {
    thrown = error;
    if (interruption.signal || error.code === 'PUBLISH_INTERRUPTED') {
      evidence.status = 'interrupted';
      evidence.error = { code: 'PUBLISH_INTERRUPTED', signal: interruption.signal ?? error.signal };
      evidence.interruption = { signal: interruption.signal ?? error.signal, child: interruption.child };
      evidence.restart = { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' };
    } else {
      evidence.status = 'failed';
      evidence.error = { code: error.code ?? 'PUBLISHER_FAILED' };
    }
  } finally {
    await interruption.settle();
    if (interruption.signal && evidence.status !== 'interrupted') {
      thrown = interruptionError(interruption.signal);
      evidence.status = 'interrupted';
      evidence.error = { code: 'PUBLISH_INTERRUPTED', signal: interruption.signal };
      evidence.interruption = { signal: interruption.signal, child: interruption.child };
      evidence.restart = { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' };
    }
    try {
      evidence.npm.durable = interruption.signal
        ? await durableNpmState(npmAdapter, packed, durableReadTimeoutMs)
        : await durableNpmState(npmAdapter, packed, durableReadTimeoutMs, interruption);
    } catch (error) {
      if (error.code !== 'PUBLISH_INTERRUPTED') throw error;
      thrown = interruptionError(interruption.signal ?? error.signal);
      evidence.status = 'interrupted';
      evidence.error = { code: 'PUBLISH_INTERRUPTED', signal: interruption.signal ?? error.signal };
      evidence.interruption = { signal: interruption.signal ?? error.signal, child: interruption.child };
      evidence.restart = { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' };
      evidence.npm.durable = await durableNpmState(npmAdapter, packed, durableReadTimeoutMs);
    }
    if (evidence.snapshot?.sha) {
      try {
        evidence.snapshot.refHeadAfter = refAdapter(repoRoot, SNAPSHOT_REF);
        if (evidence.snapshot.refHeadAfter !== evidence.snapshot.sha) {
          evidence.restart = { required: true, reason: 'REOBSERVE_RELEASE_STATE' };
        }
      } catch {
        evidence.restart = { required: true, reason: 'REOBSERVE_RELEASE_STATE' };
        evidence.snapshot.refHeadAfter = null;
      }
      let observedLine = null;
      try {
        observedLine = refAdapter(repoRoot, `refs/heads/${RELEASE_LINE}`);
        assertSha(observedLine, 'release line after publication');
        evidence.line.after = observedLine;
      } catch {
        evidence.restart = { required: true, reason: 'REOBSERVE_RELEASE_STATE' };
        evidence.line.after = null;
        evidence.line.afterRelation = 'unknown';
        evidence.line.afterCode = 'RELEASE_LINE_FINAL_READ_FAILED';
      }
      if (observedLine) {
        try {
          fetchAdapter(repoRoot, [observedLine]);
          evidence.line.afterRelation = lineRelation(repoRoot, evidence.release.mergeSha, evidence.snapshot.sha, observedLine);
          evidence.line.afterCode = null;
        } catch {
          evidence.restart = { required: true, reason: 'REOBSERVE_RELEASE_STATE' };
          evidence.line.afterRelation = 'unknown';
          evidence.line.afterCode = 'RELEASE_LINE_FINAL_FETCH_OR_RELATION_FAILED';
        }
      }
    }
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true });
        evidence.cleanup.temporary = 'removed';
      } catch {
        evidence.cleanup.temporary = 'failed';
        evidence.cleanup.code = 'TEMPORARY_CLEANUP_FAILED';
        try { fail('TEMPORARY_CLEANUP_FAILED'); } catch (error) { thrown ??= error; }
      }
    }
    if (evidence.interruption) evidence.interruption.child = interruption.child;
    try {
      if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(sanitizedEvidence(evidence), null, 2)}\n`);
    } catch {
      try { fail('EVIDENCE_WRITE_FAILED'); } catch (error) { thrown ??= error; }
    }
    if (interruption.signal && evidence.status !== 'interrupted') {
      thrown = interruptionError(interruption.signal);
      evidence.status = 'interrupted';
      evidence.error = { code: 'PUBLISH_INTERRUPTED', signal: interruption.signal };
      evidence.interruption = { signal: interruption.signal, child: interruption.child };
      evidence.restart = { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' };
      try {
        if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(sanitizedEvidence(evidence), null, 2)}\n`);
      } catch {
        try { fail('EVIDENCE_WRITE_FAILED'); } catch (error) { thrown ??= error; }
      }
    }
  }
  if (thrown) throw thrown;
  return evidence;
}

export function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || args[index + 1] === undefined) fail('PUBLISHER_ARGUMENTS_INVALID');
    values[args[index].slice(2)] = args[index + 1];
  }
  for (const key of ['repository', 'package', 'evidence']) if (!values[key]) fail('PUBLISHER_ARGUMENTS_INVALID');
  if (values.repository !== REPOSITORY) fail('PUBLISHER_REPOSITORY_INVALID');
  return values;
}

export async function runPublisherCli({
  argv = process.argv.slice(2),
  repoRoot,
  npmAdapter = liveNpmAdapter,
  refAdapter = remoteRef,
  fetchAdapter = fetchObjects,
  temporaryBase = tmpdir(),
  oidc = true,
  graceMs = 2_000,
  durableReadTimeoutMs = 5_000,
  publicationReadTimeoutMs = 5_000,
} = {}) {
  const args = parseArguments(argv);
  const interruption = createInterruptionLifecycle({ graceMs });
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => { interruption.interrupt(signal); }]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    const evidence = await publishFromSnapshot({
      repoRoot: repoRoot ?? git(process.cwd(), 'rev-parse', '--show-toplevel'),
      choice: args.package,
      evidencePath: args.evidence,
      npmAdapter,
      refAdapter,
      fetchAdapter,
      temporaryBase,
      oidc,
      interruption,
      durableReadTimeoutMs,
      publicationReadTimeoutMs,
    });
    if (interruption.signal) {
      evidence.status = 'interrupted';
      evidence.error = { code: 'PUBLISH_INTERRUPTED', signal: interruption.signal };
      evidence.interruption = { signal: interruption.signal, child: interruption.child };
      evidence.restart = { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' };
      await writeFile(args.evidence, `${JSON.stringify(sanitizedEvidence(evidence), null, 2)}\n`);
      throw interruptionError(interruption.signal);
    }
    console.log(JSON.stringify({ status: evidence.status, choice: evidence.choice }));
    return evidence;
  } catch (error) {
    if (!interruption.signal) {
      console.error(error.code ?? 'PUBLISHER_FAILED');
      process.exitCode = 1;
      return null;
    }
    await interruption.settle();
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    process.kill(process.pid, interruption.signal);
    return null;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runPublisherCli();
}
