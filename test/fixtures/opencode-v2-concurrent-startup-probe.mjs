// Explicit native regression: three independent launchers upgrade one old DB.
// Temporary native homes, fixture TUI and MCP, local provider only; no real drones.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { parseOpenCodeVersion } from '../../dist/opencode-installation.js';
import { startOpenCodeV2Server } from '../../dist/opencode-v2-server.js';
import { launchOpenCodeV2Process } from '../../dist/opencode-v2-launch.js';
import { ensureOpenCodePrivateRoot } from '../../dist/opencode-private-state.js';
import { readOpenCodeV2Descriptor, callOpenCodeV2Broker, OPENCODE_V2_DESCRIPTOR_ENV } from '../../dist/opencode-v2-broker.js';

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
  process.send({ type: 'waiting' });
  const [{ env }] = await once(process, 'message');
  let launch, tui, client, descriptorPath;
  try {
    launch = await launchOpenCodeV2Process({
      installation: { executable: binary, ...parseOpenCodeVersion(version) }, cwd: directory, env,
      prompt: 'Concurrent startup fixture', seat: { worktree: directory, cubeId: 'fixture-cube', droneId: 'fixture-drone' },
      mcpCommand: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), join(directory, 'calls.jsonl')],
      spawnProcess: (executable, args, options) => {
        assert.equal(executable, binary); assert.ok(args.includes('--server'));
        descriptorPath = options.env[OPENCODE_V2_DESCRIPTOR_ENV];
        client = OpenCode.make({ baseUrl: args[args.indexOf('--server') + 1],
          headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + options.env.OPENCODE_PASSWORD).toString('base64') },
          fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(60_000) }) });
        tui = new EventEmitter();
        tui.kill = () => { tui.emit('exit', 0); tui.emit('close', 0); return true; };
        queueMicrotask(() => tui.emit('spawn'));
        return tui;
      },
    });
    const descriptor = readOpenCodeV2Descriptor(descriptorPath);
    const status = await callOpenCodeV2Broker(descriptor, '/status');
    assert.equal(status.pluginReady, true); assert.ok(status.tools.length);
    await client.session.wait({ sessionID: descriptor.sessionID }, { signal: AbortSignal.timeout(60_000) });
    process.send({ type: 'ready', pid: descriptor.server.pid });
    await once(process, 'message');
    assert.equal((await callOpenCodeV2Broker(descriptor, '/status')).pluginReady, true);
    process.send({ type: 'alive' });
    await once(process, 'message');
  } catch {
    // Native responses/configuration may contain secrets. Keep failures fixed.
    process.send({ type: 'failed' }); process.exitCode = 1;
  } finally { tui?.kill(); await launch?.cleanup(); process.disconnect(); }

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
    OPENCODE_DB: join(root, '.config', 'borgmcp', ...(process.platform === 'win32' ? ['opencode-launches'] : []), 'opencode-v2.db'), OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: '{"update":"disable","snapshots":false}',

  };
  let generations = 0;
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) {} // Drain fixture input without retaining it.
    generations++;
    res.setHeader('Content-Type', 'text/event-stream');
    for (const value of [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture complete.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'model', ...value })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: 'disable', snapshots: false, model: 'borg-fixture/model',
    providers: { 'borg-fixture': { package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture' },
      models: { model: { name: 'Fixture', limit: { context: 32000, output: 1024 } } } } } });
  const children = [];
  let old;
  let succeeded = false;
  try {
    ensureOpenCodePrivateRoot(join(root, '.config', 'borgmcp', ...(process.platform === 'win32' ? ['opencode-launches'] : [])));
    const oldVersion = execFileSync(previous, ['--version'], { env, encoding: 'utf8', timeout: 5000 }).trim();
    const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 5000 }).trim();
    old = await startOpenCodeV2Server({ installation: { executable: previous, ...parseOpenCodeVersion(oldVersion) },
      directory: directories[0], env, readyTimeoutMs: 60_000 });
    await old.close(); old = undefined;
    const ready = [];
    const alive = [];
    const waiting = directories.map(directory => {
      // The launcher needs its normal OS environment (notably PowerShell on
      // Windows). Only the native host receives the credential-free env above.
      // Borg's state stays isolated by BORG_STATE_ROOT in both processes.
      const child = fork(self, ['--worker', root, binary, version, directory], {
        env: { ...process.env, BORG_STATE_ROOT: root },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      let waitingResolve, waitingReject;
      const atBarrier = new Promise((resolve, reject) => { waitingResolve = resolve; waitingReject = reject; });
      let aliveResolve, aliveReject;
      const live = new Promise((resolve, reject) => { aliveResolve = resolve; aliveReject = reject; });
      void live.catch(() => {}); alive.push(live);
      const prepared = new Promise((resolve, reject) => {
        child.on('message', message => {
          if (message.type === 'waiting') waitingResolve();
          if (message.type === 'ready') resolve(message.pid);
          if (message.type === 'alive') aliveResolve();
          if (message.type === 'failed') reject(new Error('Production launcher failed during shared-database startup'));
        });
        child.once('error', error => { waitingReject(error); reject(error); aliveReject(error); });
        child.once('exit', code => {
          const error = new Error(`Native worker exited before readiness (${code})`);
          waitingReject(error); reject(error); aliveReject(error);
        });
      });
      void prepared.catch(() => {});
      ready.push(prepared);
      return atBarrier;
    });
    await bounded(Promise.all(waiting));
    children.forEach(child => child.send({ env }));
    const pids = await bounded(Promise.all(ready));
    assert.equal(new Set(pids).size, 3);
    children.forEach(child => child.send('verify'));
    await bounded(Promise.all(alive));
    assert.ok(children.every(child => child.exitCode === null && child.signalCode === null));
    assert.equal(generations, 3, 'Each production launcher admits exactly one kickoff to the local provider');
    console.log(JSON.stringify({ previous: oldVersion, version, simultaneousUpgrade: 'passed', servers: pids.length,
      entrypoint: 'launchOpenCodeV2Process', pluginReady: true, projectConfig: 'enabled', localGenerations: generations, externalModelRequests: 0 }));
    succeeded = true;
  } finally {
    await old?.close();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'exit');
      if (child.connected) child.send('close', () => {});
      const force = setTimeout(() => { succeeded = false; child.kill('SIGKILL'); }, 15000);
      try { await closed; } finally { clearTimeout(force); }
    }));
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error(`Native startup evidence retained at ${root}`);
  }
}
