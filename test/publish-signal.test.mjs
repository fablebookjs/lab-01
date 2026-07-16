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

async function runFixture(environment, signal) {
  const child = spawn(process.execPath, [new URL('./fixtures/publish-signal-cli.mjs', import.meta.url).pathname], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolvePromise) => child.once('close', (code, childSignal) => resolvePromise({ code, signal: childSignal })));
  if (signal) {
    await waitForFile(environment.LAB_SIGNAL_MARKER);
    child.kill(signal);
  }
  return closed;
}

for (const fixture of [
  { choice: 'core', signal: 'SIGINT', mode: 'cooperative' },
  { choice: 'core', signal: 'SIGTERM', mode: 'ignore' },
  { choice: 'addon', signal: 'SIGINT', mode: 'ignore' },
  { choice: 'addon', signal: 'SIGTERM', mode: 'cooperative' },
]) {
  test(`managed ${fixture.signal} during ${fixture.choice} publish settles descendants, evidence, cleanup, and rerun`, { skip: process.platform === 'win32' }, async () => {
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
      assert.equal(interrupted.interruption.child.settled, true);
      assert.equal(interrupted.interruption.child.escalated, fixture.mode === 'ignore');
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
