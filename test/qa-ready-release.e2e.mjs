import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readdir, writeFile } from 'node:fs/promises';

import {
  REPOSITORY,
  localAuthority,
  runReadyReleaseQa,
  withTemporaryDirectory,
} from '../scripts/qa-ready-release.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function localIntent(repoRoot, sourceSha) {
  const message = `release: propose v1.0.1

Release-Intent-Version: 1
Release-Line: releases/v1.0
Release-Version: 1.0.1
Release-Source: ${sourceSha}
`;
  return execFileSync('git', ['commit-tree', `${sourceSha}^{tree}`, '-p', sourceSha], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    },
  }).trim();
}

test('adversarial ambient npm/Git config is rejected before candidate, publish, or consumer traffic', async () => {
  const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const sourceSha = git(repoRoot, 'rev-parse', 'HEAD');
  const stagedSha = localIntent(repoRoot, sourceSha);
  const requests = [];
  const trap = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(503).end('ambient registry/proxy trap');
  });
  trap.on('connect', (request, socket) => {
    requests.push(`CONNECT ${request.url}`);
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    trap.once('error', reject);
    trap.listen(0, '127.0.0.1', resolve);
  });
  const trapOrigin = `http://127.0.0.1:${trap.address().port}/`;

  try {
    await withTemporaryDirectory('lab-01-adversarial-env-', async (directory) => {
      const userConfig = join(directory, 'ambient-user.npmrc');
      const globalConfig = join(directory, 'ambient-global.npmrc');
      const ambientHome = join(directory, 'ambient-home');
      await writeFile(
        userConfig,
        `registry=https://registry.npmjs.org/
@fablebook:registry=${trapOrigin}
//registry.npmjs.org/:_authToken=ambient-public-token
proxy=${trapOrigin}
https-proxy=${trapOrigin}
`,
      );
      await writeFile(globalConfig, `@fablebook:registry=http://127.0.0.1:9/\n`);
      const hostile = {
        HOME: ambientHome,
        npm_config_registry: 'https://registry.npmjs.org/',
        NPM_CONFIG_REGISTRY: trapOrigin,
        'npm_config_@fablebook:registry': 'http://127.0.0.1:9/',
        'NPM_CONFIG_@FABLEBOOK:REGISTRY': trapOrigin,
        npm_config_userconfig: userConfig,
        NPM_CONFIG_USERCONFIG: userConfig,
        npm_config_globalconfig: globalConfig,
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        npm_config__auth: 'ambient-auth',
        npm_config__authToken: 'ambient-token',
        'npm_config_//registry.npmjs.org/:_authToken': 'ambient-public-token',
        NPM_TOKEN: 'ambient-token',
        NODE_AUTH_TOKEN: 'ambient-token',
        HTTP_PROXY: trapOrigin,
        HTTPS_PROXY: trapOrigin,
        ALL_PROXY: trapOrigin,
        http_proxy: trapOrigin,
        https_proxy: trapOrigin,
        all_proxy: trapOrigin,
      };
      const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
      Object.assign(process.env, hostile);
      try {
        await assert.rejects(
          runReadyReleaseQa({
            repository: REPOSITORY,
            stagedSha,
            sourceSha,
            repoRoot,
            authority: localAuthority(),
          }),
          /AMBIENT_GIT_CONFIG_PROHIBITED/,
        );
        assert.deepEqual(requests, []);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  } finally {
    await new Promise((resolve, reject) => trap.close((error) => (error ? reject(error) : resolve())));
  }
});

test('a late injected failure removes registry, worktree, credentials, cache, and consumer state', async () => {
  const repoRoot = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const sourceSha = git(repoRoot, 'rev-parse', 'HEAD');
  const stagedSha = localIntent(repoRoot, sourceSha);
  await assert.rejects(
    runReadyReleaseQa({
      repository: REPOSITORY,
      stagedSha,
      sourceSha,
      repoRoot,
      authority: localAuthority(),
      testHooks: {
        afterRegistryReady() {
          throw new Error('injected post-registry failure');
        },
      },
    }),
    /injected post-registry failure/,
  );
  const residue = (await readdir(tmpdir())).filter((name) =>
    name.startsWith('fablebook-lab-01-ready-qa-'),
  );
  assert.deepEqual(residue, []);
  assert.doesNotMatch(git(repoRoot, 'worktree', 'list', '--porcelain'), /fablebook-lab-01-ready-qa-/);
});
