import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();

async function waitForFile(path, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 25)); }
  }
  assert.fail('signal fixture did not reach the publish window');
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail(`descendant ${pid} survived publisher termination`);
}

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

async function advanceLateLine(root) {
  const meta = JSON.parse(await readFile(join(root, 'release-meta.json'), 'utf8'));
  const writer = join(root, 'late-writer');
  git(root, 'clone', '--quiet', join(root, 'remote.git'), writer);
  const tree = git(writer, 'rev-parse', `${meta.mergeSha}^{tree}`);
  const lateSha = git(writer, 'commit-tree', tree, '-p', meta.mergeSha, '-m', 'late X');
  git(writer, 'push', '--quiet', 'origin', `${lateSha}:refs/heads/releases/v1.0`);
  await writeFile(join(root, 'late-sha'), `${lateSha}\n`);
  return lateSha;
}

async function runFixture(environment, signal) {
  let lateSha = null;
  const child = spawn(process.execPath, [new URL('./fixtures/publish-signal-cli.mjs', import.meta.url).pathname], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolvePromise) => child.once('close', (code, childSignal) => resolvePromise({ code, signal: childSignal })));
  if (signal) {
    await waitForFile(environment.LAB_SIGNAL_MARKER);
    if (environment.LAB_SIGNAL_LATE_LINE === '1') lateSha = await advanceLateLine(environment.LAB_SIGNAL_ROOT);
    child.kill(signal);
  }
  return { ...(await closed), lateSha };
}

for (const fixture of [
  { choice: 'core', signal: 'SIGINT', mode: 'cooperative' },
  { choice: 'core', signal: 'SIGTERM', mode: 'ignore' },
  { choice: 'addon', signal: 'SIGINT', mode: 'ignore' },
  { choice: 'addon', signal: 'SIGTERM', mode: 'cooperative' },
  { choice: 'core', signal: 'SIGINT', mode: 'leader-cooperative-descendant-ignore' },
  { choice: 'addon', signal: 'SIGTERM', mode: 'leader-cooperative-descendant-ignore' },
  { choice: 'core', signal: 'SIGTERM', mode: 'early-leader-descendant-ignore' },
  { choice: 'addon', signal: 'SIGINT', mode: 'early-leader-descendant-ignore' },
]) {
  test(`managed ${fixture.signal} during ${fixture.choice} publish (${fixture.mode}) settles descendants, evidence, cleanup, and rerun`, { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), `lab-01-${fixture.choice}-${fixture.signal.toLowerCase()}-`));
    const bin = join(root, 'bin');
    const state = join(root, 'registry.json');
    const marker = join(root, 'publish-started');
    const descendant = join(root, 'descendant.pid');
    const evidence = join(root, 'interrupted.json');
    const shim = join(bin, 'npm');
    try {
      await mkdir(bin, { recursive: true });
      await writeFile(shim, `#!/usr/bin/env node\nconst {spawnSync}=require('child_process');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('11.18.0');process.exit(0)}const r=spawnSync(${JSON.stringify(realNpm)},a,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(r.status??1)\n`);
      await chmod(shim, 0o755);
      const environment = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        LAB_SIGNAL_ROOT: root,
        LAB_SIGNAL_CHOICE: fixture.choice,
        LAB_SIGNAL_MODE: fixture.mode,
        LAB_SIGNAL_STATE: state,
        LAB_SIGNAL_EVIDENCE: evidence,
        LAB_SIGNAL_MARKER: marker,
        LAB_SIGNAL_DESCENDANT: descendant,
      };
      const stopped = await runFixture(environment, fixture.signal);
      assert.equal(stopped.code, null);
      assert.equal(stopped.signal, fixture.signal);
      const descendantPid = Number((await readFile(descendant, 'utf8')).trim());
      await waitForExit(descendantPid);
      const interrupted = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(interrupted.status, 'interrupted');
      assert.deepEqual(interrupted.error, { code: 'PUBLISH_INTERRUPTED', signal: fixture.signal });
      assert.equal(interrupted.interruption.signal, fixture.signal);
      assert.equal(interrupted.interruption.child.started, true);
      assert.equal(interrupted.interruption.child.forwarded, true);
      assert.equal(interrupted.interruption.child.leaderSettled, true);
      assert.equal(interrupted.interruption.child.groupSettled, true);
      assert.equal(interrupted.interruption.child.settled, true);
      assert.equal(interrupted.interruption.child.escalated, fixture.mode !== 'cooperative');
      assert.deepEqual(interrupted.restart, { required: true, reason: 'REOBSERVE_DURABLE_NPM_STATE' });
      assert.deepEqual(interrupted.npm.durable.map(({ name, status }) => ({ name, status })), [
        { name: '@fablebook/lab-01-core', status: 'matching' },
        { name: '@fablebook/lab-01-addon', status: fixture.choice === 'addon' ? 'matching' : 'absent' },
      ]);
      assert.equal(interrupted.cleanup.temporary, 'removed');
      assert.equal(interrupted.snapshot.refHeadAfter, interrupted.snapshot.sha);
      assert.equal(interrupted.line.after, interrupted.release.mergeSha);
      assert.equal(interrupted.line.afterRelation, 'at-merge');
      assert.doesNotMatch(JSON.stringify(interrupted), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual((await readdir(join(root, 'publisher-temporary'))).filter((name) => name.startsWith('lab-01-publish-')), []);

      await rm(marker, { force: true });
      const rerunEvidence = join(root, 'rerun.json');
      const rerun = await runFixture({ ...environment, LAB_SIGNAL_EVIDENCE: rerunEvidence, LAB_SIGNAL_MARKER: marker }, null);
      assert.equal(rerun.code, 0);
      assert.equal(rerun.signal, null);
      const converged = JSON.parse(await readFile(rerunEvidence, 'utf8'));
      assert.equal(converged.status, 'succeeded');
      assert.equal(converged.npm.publication.result, 'reused');
      assert.equal(converged.cleanup.temporary, 'removed');
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const fixture of [
  { choice: 'core', signal: 'SIGINT', hang: 'initial' },
  { choice: 'addon', signal: 'SIGTERM', hang: 'ambiguous' },
  { choice: 'core', signal: 'SIGTERM', hang: 'durable' },
]) {
  test(`managed ${fixture.signal} aborts hanging ${fixture.hang} registry observation with named durable evidence`, { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), `lab-01-hang-${fixture.hang}-`));
    const bin = join(root, 'bin');
    const evidence = join(root, 'interrupted.json');
    const marker = join(root, 'query-started');
    try {
      await mkdir(bin, { recursive: true });
      const shim = join(bin, 'npm');
      await writeFile(shim, `#!/usr/bin/env node\nconst {spawnSync}=require('child_process');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('11.18.0');process.exit(0)}const r=spawnSync(${JSON.stringify(realNpm)},a,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(r.status??1)\n`);
      await chmod(shim, 0o755);
      const environment = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        LAB_SIGNAL_ROOT: root,
        LAB_SIGNAL_CHOICE: fixture.choice,
        LAB_SIGNAL_MODE: 'cooperative',
        LAB_SIGNAL_HANG: fixture.hang,
        LAB_SIGNAL_STATE: join(root, 'registry.json'),
        LAB_SIGNAL_EVIDENCE: evidence,
        LAB_SIGNAL_MARKER: marker,
        LAB_SIGNAL_DESCENDANT: join(root, 'descendant.pid'),
      };
      const stopped = await runFixture(environment, fixture.signal);
      assert.equal(stopped.code, null);
      assert.equal(stopped.signal, fixture.signal);
      const interrupted = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(interrupted.status, 'interrupted');
      assert.equal(interrupted.cleanup.temporary, 'removed');
      assert.deepEqual(interrupted.npm.durable.map(({ name, status }) => ({ name, status })), [
        { name: '@fablebook/lab-01-core', status: fixture.choice === 'addon' ? 'matching' : 'absent' },
        { name: '@fablebook/lab-01-addon', status: 'absent' },
      ]);
      assert.deepEqual((await readdir(join(root, 'publisher-temporary'))).filter((name) => name.startsWith('lab-01-publish-')), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const fixture of [
  { signal: 'SIGTERM', fetchFails: false },
  { signal: 'SIGINT', fetchFails: true },
]) {
  test(`interrupted late X is preserved with ${fixture.fetchFails ? 'unknown relation on fetch failure' : 'verified late-descendant relation'}`, { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'lab-01-late-line-'));
    const bin = join(root, 'bin');
    const evidence = join(root, 'interrupted.json');
    try {
      await mkdir(bin, { recursive: true });
      const shim = join(bin, 'npm');
      await writeFile(shim, `#!/usr/bin/env node\nconst {spawnSync}=require('child_process');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('11.18.0');process.exit(0)}const r=spawnSync(${JSON.stringify(realNpm)},a,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(process.env.PATH)}}});process.exit(r.status??1)\n`);
      await chmod(shim, 0o755);
      const stopped = await runFixture({
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        LAB_SIGNAL_ROOT: root,
        LAB_SIGNAL_CHOICE: 'core',
        LAB_SIGNAL_MODE: 'cooperative',
        LAB_SIGNAL_LATE_LINE: '1',
        LAB_SIGNAL_FETCH_FAIL: fixture.fetchFails ? '1' : '0',
        LAB_SIGNAL_STATE: join(root, 'registry.json'),
        LAB_SIGNAL_EVIDENCE: evidence,
        LAB_SIGNAL_MARKER: join(root, 'publish-started'),
        LAB_SIGNAL_DESCENDANT: join(root, 'descendant.pid'),
      }, fixture.signal);
      assert.equal(stopped.signal, fixture.signal);
      const interrupted = JSON.parse(await readFile(evidence, 'utf8'));
      assert.equal(interrupted.line.after, stopped.lateSha);
      assert.equal(interrupted.line.afterRelation, fixture.fetchFails ? 'unknown' : 'late-descendant');
      assert.equal(interrupted.line.afterCode, fixture.fetchFails ? 'RELEASE_LINE_FINAL_FETCH_OR_RELATION_FAILED' : null);
      if (fixture.fetchFails) assert.deepEqual(interrupted.restart, { required: true, reason: 'REOBSERVE_RELEASE_STATE' });
      assert.doesNotMatch(JSON.stringify(interrupted), /raw test fetch failure/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
