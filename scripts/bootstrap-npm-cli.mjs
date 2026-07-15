import { execFile } from 'node:child_process';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org/';
const VERSION = '11.18.0';

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

async function walk(directory, root, found) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('NPM_BOOTSTRAP_SYMLINK');
    if (entry.isDirectory()) await walk(path, root, found);
    else if (entry.isFile() && entry.name.toLowerCase() === '.npmrc') found.push(path.slice(root.length + 1));
  }
}

export async function assertNoProjectNpmrc(repoRoot) {
  const found = [];
  await walk(repoRoot, repoRoot, found);
  if (found.length > 0) fail('PROJECT_NPM_CONFIG_PROHIBITED');
}

export function assertNoAmbientPackageConfiguration(environment = process.env) {
  const prohibited = Object.keys(environment).filter((key) =>
    /^(?:npm_config_|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$|NO_PROXY$|no_proxy$|CURL_CA_BUNDLE$|SSL_CERT_FILE$)/.test(key),
  );
  if (prohibited.length > 0) fail('AMBIENT_PACKAGE_CONFIG_PROHIBITED');
}

function closedEnvironment(root, npmBin) {
  return {
    PATH: `${npmBin}:${process.env.PATH}`,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    CI: 'true',
    NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'),
    NPM_CONFIG_CACHE: join(root, 'cache'),
    NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FETCH_RETRIES: '0',
  };
}

async function runNpm(npm, args, options) {
  try {
    return await execFileAsync(npm, args, { ...options, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    fail('NPM_BOOTSTRAP_COMMAND_FAILED');
  }
}

export async function bootstrapNpm({ repoRoot, pathFile, projectTools = false, base = process.env.RUNNER_TEMP ?? tmpdir() }) {
  await assertNoProjectNpmrc(repoRoot);
  assertNoAmbientPackageConfiguration();
  const root = resolve(base, 'lab-01-npm-bootstrap');
  const prefix = join(root, 'toolchain');
  const bin = join(prefix, 'bin');
  const neutral = join(root, 'neutral');
  await Promise.all([
    mkdir(join(root, 'home'), { recursive: true }),
    mkdir(join(root, 'tmp'), { recursive: true }),
    mkdir(join(root, 'cache'), { recursive: true }),
    mkdir(neutral, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    writeFile(join(root, 'user.npmrc'), `registry=${REGISTRY}\n@fablebook:registry=${REGISTRY}\n`, { mode: 0o600 }),
    writeFile(join(root, 'global.npmrc'), '', { mode: 0o600 }),
  ]);
  const ambientNpm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const environment = closedEnvironment(root, bin);
  await runNpm(
    ambientNpm,
    ['install', '--global', `--prefix=${prefix}`, `npm@${VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`],
    { cwd: neutral, env: { ...environment, PATH: process.env.PATH } },
  );
  const npm = join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const observed = await runNpm(npm, ['--version'], { cwd: neutral, env: environment });
  if (observed.stdout.trim() !== VERSION) fail('NPM_BOOTSTRAP_VERSION_MISMATCH');
  if (projectTools) {
    await runNpm(
      npm,
      ['ci', `--prefix=${repoRoot}`, '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`],
      { cwd: neutral, env: environment },
    );
  }
  if (pathFile) {
    const file = await open(pathFile, 'a');
    try { await file.write(`${bin}\n`); } finally { await file.close(); }
  }
  return { version: VERSION, bin: basename(bin), projectTools };
}

function argumentsFrom(argv) {
  const values = { projectTools: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-tools') values.projectTools = true;
    else if (argv[index] === '--repository-root') values.repoRoot = argv[++index];
    else if (argv[index] === '--path-file') values.pathFile = argv[++index];
    else fail('NPM_BOOTSTRAP_ARGUMENTS_INVALID');
  }
  if (!values.repoRoot || !values.pathFile) fail('NPM_BOOTSTRAP_ARGUMENTS_INVALID');
  return values;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  bootstrapNpm(argumentsFrom(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error.code ?? 'NPM_BOOTSTRAP_FAILED');
    process.exitCode = 1;
  });
}
