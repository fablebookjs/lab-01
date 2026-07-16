import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [statePath, markerPath, descendantPath, artifactText, mode] = process.argv.slice(2);
const artifact = JSON.parse(Buffer.from(artifactText, 'base64url').toString('utf8'));
const ignore = mode === 'ignore';
const descendant = spawn(process.execPath, ['-e', ignore
  ? "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  : 'setInterval(()=>{},1000)'], { detached: false, stdio: 'ignore' });
writeFileSync(descendantPath, `${descendant.pid}\n`);

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
    if (!ignore) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
  });
}

writeFileSync(markerPath, 'started\n');
setInterval(() => {}, 1_000);
