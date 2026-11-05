// Explicit native regression: three independent launchers upgrade one old DB.
// Temporary homes only; no TUI, kickoff, credentials, or model requests.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { parseOpenCodeVersion } from '../../dist/opencode-installation.js';
import { startOpenCodeV2Server } from '../../dist/opencode-v2-server.js';
import { withOpenCodeV2Startup } from '../../dist/opencode-v2-startup.js';

const self = fileURLToPath(import.meta.url);
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native concurrent startup probe timed out')), 180_000);
    })]);
  } finally { clearTimeout(timer); }
}
if (process.argv[2] === '--worker') {
  const [root, binary, version, directory] = process.argv.slice(3);
  let stage = 'mutex';
  const start = async () => {
    stage = 'server';
    const server = await startOpenCodeV2Server({
      installation: { executable: binary, ...parseOpenCodeVersion(version) }, directory,
      env: process.env, readyTimeoutMs: 60_000,
    });
    try {
      stage = 'configuration';
      const client = OpenCode.make({ baseUrl: server.url, headers: server.headers(),
        fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) }) });
      await client.config.get({ location: { directory } });
      assert.equal((await fetch(`${server.url}/api/info`)).status, 401);
      return server;
    } catch (error) { await server.close(); throw error; }
  };
  process.send({ type: 'waiting' });
  await once(process, 'message');
  let server;
  try {
    server = await (process.env.OPENCODE_TEST_UNGATED === '1' ? start() : withOpenCodeV2Startup(start));
    process.send({ type: 'ready', pid: server.pid });
    await once(process, 'message');
  } catch (error) {
    // Fixed classifications only: native responses/configuration can contain secrets.
    const reason = error?.message?.includes('current Windows user') ? 'private-acl'
      : error?.message?.includes('private regular file') ? 'private-file'
      : error?.message?.includes('symlink') ? 'canonical-path' : 'other';
    process.send({ type: 'failed', stage, reason,
      sqliteCode: Number.isInteger(error?.errcode) ? error.errcode : undefined });
    process.exitCode = 1;
  }
  finally { await server?.close(); process.disconnect(); }
} else {
  const binary = realpathSync(process.env.OPENCODE_TEST_V2_BINARY ?? '');
  const previous = realpathSync(process.env.OPENCODE_TEST_V2_PREVIOUS_BINARY ?? '');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'borg-native-shared-upgrade-'));
  const directories = Array.from({ length: 3 }, (_, i) => join(root, 'worktrees', 'repository', `drone-${i}`));
  directories.forEach(directory => mkdirSync(directory, { recursive: true }));
  for (const name of ['appdata', 'localappdata', 'tmp']) mkdirSync(join(root, name));
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    HOME: root, USERPROFILE: root, BORG_STATE_ROOT: root,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_DB: join(root, 'upgrade.db'), OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: '{"update":"disable","snapshots":false}',
    OPENCODE_TEST_UNGATED: process.env.OPENCODE_TEST_UNGATED,
  };
  const children = [];
  let old;
  let succeeded = false;
  try {
    const oldVersion = execFileSync(previous, ['--version'], { env, encoding: 'utf8' }).trim();
    const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' }).trim();
    old = await startOpenCodeV2Server({ installation: { executable: previous, ...parseOpenCodeVersion(oldVersion) },
      directory: directories[0], env, readyTimeoutMs: 60_000 });
    await old.close(); old = undefined;
    const ready = [];
    const waiting = directories.map(directory => {
      const child = fork(self, ['--worker', root, binary, version, directory], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      let waitingResolve, waitingReject;
      const atBarrier = new Promise((resolve, reject) => { waitingResolve = resolve; waitingReject = reject; });
      const prepared = new Promise((resolve, reject) => {
        child.on('message', message => {
          if (message.type === 'waiting') waitingResolve();
          if (message.type === 'ready') resolve(message.pid);
          if (message.type === 'failed') reject(new Error(`Native worker failed during shared-database startup (${message.stage}, ${message.reason}, sqlite=${message.sqliteCode ?? 'none'})`));
        });
        child.once('error', error => { waitingReject(error); reject(error); });
        child.once('exit', code => {
          const error = new Error(`Native worker exited before readiness (${code})`);
          waitingReject(error); reject(error);
        });
      });
      void prepared.catch(() => {});
      ready.push(prepared);
      return atBarrier;
    });
    await bounded(Promise.all(waiting));
    children.forEach(child => child.send('start'));
    const pids = await bounded(Promise.all(ready));
    assert.equal(new Set(pids).size, 3);
    console.log(JSON.stringify({ previous: oldVersion, version, simultaneousUpgrade: 'passed', servers: pids.length,
      gated: process.env.OPENCODE_TEST_UNGATED !== '1', projectConfig: 'enabled', modelRequests: 0 }));
    succeeded = true;
  } finally {
    await old?.close();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'exit');
      if (child.connected) child.send('close', () => {});
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(force); }
    }));
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error(`Native startup evidence retained at ${root}`);
  }
}
