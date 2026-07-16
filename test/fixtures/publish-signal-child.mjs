import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [statePath, markerPath, descendantPath, artifactText, mode] = process.argv.slice(2);
const artifact = JSON.parse(Buffer.from(artifactText, 'base64url').toString('utf8'));
const leaderIgnores = mode === 'ignore';
const descendantIgnores = leaderIgnores || mode.includes('descendant-ignore');
const descendantProgram = `${descendantIgnores ? "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});" : ''}process.send('ready');setInterval(()=>{},1000)`;
const descendant = spawn(process.execPath, ['-e', descendantProgram], {
  detached: false,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});

function recordPublication() {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state[artifact.name] = {
    status: 'present',
    name: artifact.name,
    version: '1.0.1',
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    repository: { type: 'git', url: 'git+https://github.com/fablebookjs/lab-01.git', directory: artifact.directory },
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    recordPublication();
    if (!leaderIgnores) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
  });
}

descendant.once('message', () => {
  writeFileSync(descendantPath, `${descendant.pid}\n`);
  writeFileSync(markerPath, 'started\n');
  if (mode === 'fail-fast') {
    descendant.kill('SIGTERM');
    descendant.disconnect();
    descendant.unref();
    process.exitCode = 1;
  } else if (mode === 'early-leader-descendant-ignore') {
    recordPublication();
    descendant.disconnect();
    descendant.unref();
    process.exitCode = 0;
  } else {
    descendant.disconnect();
    setInterval(() => {}, 1_000);
  }
});
