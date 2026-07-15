import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const bootstrapUrl = pathToFileURL(
  new URL('../scripts/bootstrap-npm-baseline.mjs', import.meta.url).pathname,
).href;

async function waitForOutput(child, expected) {
  let output = '';
  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error(`timed out waiting for ${expected}`)),
      5_000,
    );
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolvePromise();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('exit', (code, signal) => {
      if (output.includes(expected)) return;
      clearTimeout(timeout);
      rejectPromise(new Error(`driver exited before ${expected}: ${code ?? signal}`));
    });
  });
  return output;
}

async function collectExit(child, prefix = '') {
  let stdout = prefix;
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error('signal driver did not exit'));
    }, 5_000);
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
  });
  return { ...result, stdout, stderr };
}

test(
  'forwards termination signals to real login and publish children, cleans up, and exits by signal',
  { skip: process.platform === 'win32' },
  async (context) => {
    const base = await mkdtemp(join(tmpdir(), 'bootstrap-signal-test-'));
    const helper = join(base, 'blocking-child.mjs');
    const groupHelper = join(base, 'blocking-group-member.mjs');
    const driver = join(base, 'driver.mjs');
    const runBase = join(base, 'runs');
    await writeFile(
      groupHelper,
      `import { appendFileSync } from 'node:fs';
const [marker, phase] = process.argv.slice(2);
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) {
  process.on(signal, () => {
    appendFileSync(marker, \`group:${'${phase}:${signal}'}\\n\`);
    for (const current of signals) process.removeAllListeners(current);
    process.kill(process.pid, signal);
  });
}
console.log('GROUP-READY');
setInterval(() => {}, 1_000);
`,
    );
    await writeFile(
      helper,
      `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const [marker, phase, groupHelper] = process.argv.slice(2);
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) {
  process.on(signal, () => {
    appendFileSync(marker, \`child:${'${phase}:${signal}'}\\n\`);
    for (const current of signals) process.removeAllListeners(current);
    process.kill(process.pid, signal);
  });
}
const groupMember = spawn(process.execPath, [groupHelper, marker, phase], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
groupMember.stdout.setEncoding('utf8');
groupMember.stdout.on('data', (value) => {
  if (value.includes('GROUP-READY')) console.log(\`ACTIVE:${'${phase}'}\`);
});
`,
    );
    await writeFile(
      driver,
      `import { mkdir } from 'node:fs/promises';
import {
  BOOTSTRAP,
  CONFIRMATION,
  exitForInterruption,
  hashBytes,
  runBootstrap,
} from ${JSON.stringify(bootstrapUrl)};

const [target, runBase, helper, groupHelper, marker] = process.argv.slice(2);
await mkdir(runBase, { recursive: true });
const packages = BOOTSTRAP.packages.map((value, index) => ({
  ...value,
  tarball: \`/fixture/package-${'${index}'}.tgz\`,
  ...hashBytes(Buffer.alloc(64, index + 1)),
}));
const artifacts = {
  repository: BOOTSTRAP.repository,
  source: { tag: BOOTSTRAP.tag, commit: BOOTSTRAP.commit, tree: BOOTSTRAP.tree },
  packages,
};
const matching = (artifact) => ({
  metadata: { integrity: artifact.integrity, shasum: artifact.shasum },
  tarball: { integrity: artifact.integrity, shasum: artifact.shasum },
});
const block = (context, phase) => context.run(
  process.execPath,
  [helper, marker, phase, groupHelper],
  {
    cwd: context.commandDirectory,
    env: { PATH: process.env.PATH },
    interactive: true,
    phase,
  },
);
const operations = {
  async prepareArtifacts() { return artifacts; },
  async queryVersion(_context, artifact) {
    if (target === 'addon' && artifact.name === BOOTSTRAP.packages[0].name) {
      return matching(artifact);
    }
    return null;
  },
  async login(context) {
    if (target === 'login') await block(context, 'npm-login');
  },
  async verifyBeforePublish(_context, artifact) {
    return { integrity: artifact.integrity, shasum: artifact.shasum };
  },
  async publish(context, artifact) {
    const expected = target === 'core' ? BOOTSTRAP.packages[0].name : BOOTSTRAP.packages[1].name;
    if (artifact.name === expected) await block(context, \`npm-publish:${'${artifact.name}'}\`);
  },
};

try {
  await runBootstrap({
    mode: 'publish',
    operations,
    interactive: true,
    prompt: async () => CONFIRMATION,
    temporaryBase: runBase,
  });
  process.exitCode = 90;
} catch (error) {
  if (!exitForInterruption(error)) {
    console.error('driver failed closed');
    process.exitCode = 91;
  }
}
`,
    );

    try {
      const phases = {
        login: 'npm-login',
        core: 'npm-publish:@fablebook/lab-01-core',
        addon: 'npm-publish:@fablebook/lab-01-addon',
      };
      for (const target of Object.keys(phases)) {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
          await context.test(`${target} handles ${signal}`, async () => {
            const marker = join(base, `${target}-${signal}.marker`);
            const child = spawn(
              process.execPath,
              [driver, target, runBase, helper, groupHelper, marker],
              {
              stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            const prefix = await waitForOutput(child, `ACTIVE:${phases[target]}`);
            assert.equal(child.kill(signal), true);
            const result = await collectExit(child, prefix);
            assert.equal(result.code, null, result.stderr);
            assert.equal(result.signal, signal, result.stderr);
            assert.deepEqual(
              (await readFile(marker, 'utf8')).trim().split('\n').sort(),
              [`child:${phases[target]}:${signal}`, `group:${phases[target]}:${signal}`].sort(),
            );
            assert.match(result.stdout, /"outcome": "interrupted"/);
            assert.match(
              result.stdout,
              /"registryState": "unknown-requires-integrity-readback-before-resume"/,
            );
            assert.match(result.stdout, /"temporaryStateRemoved": true/);
            assert.equal(result.stdout.includes(runBase), false);
            assert.equal(result.stdout.includes('npmrc'), false);
            assert.deepEqual(await readdir(runBase), []);
          });
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
