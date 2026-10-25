// Invoked explicitly with a published native binary; never contacts a model provider.
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const binary = process.env.OPENCODE_TEST_V2_BINARY;
assert.ok(binary, 'Set OPENCODE_TEST_V2_BINARY');
const realSeat = Boolean(process.env.OPENCODE_TEST_SEAT_HOME);
const v1Binary = process.env.OPENCODE_TEST_V1_BINARY;
if (realSeat) assert.ok(process.env.CI === 'true' && process.env.BORG_E2E === '1' && process.platform === 'linux');
const root = realSeat ? realpathSync(process.env.OPENCODE_TEST_SEAT_HOME) : mkdtempSync(join(realpathSync(tmpdir()), 'borg v2 & launch-'));
const directory = realSeat ? realpathSync(process.env.OPENCODE_TEST_SEAT_WORKTREE) : root;
process.env.BORG_STATE_ROOT = root;
const requests = [];
let configuredProviderCredential = true;
const providerSteps = [];
// Only paths/status/timing: never print authorization, request bodies, or API responses.
const nativeRequests = [];
let nativePlugins;
let nativeOrigin;
let nativeHeaders;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
  const started = Date.now();
  try {
    const response = await originalFetch(input, init);
    nativeRequests.push({ pathname, status: response.status, milliseconds: Date.now() - started });
    if (pathname === '/api/info' && response.ok) {
      nativeOrigin = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin;
      nativeHeaders = init?.headers;
    }
    if (!realSeat && process.platform === 'win32' && nativeOrigin && pathname === '/status') {
      try {
        const state = await originalFetch(new URL('/api/plugin', nativeOrigin),
          { headers: nativeHeaders, signal: AbortSignal.timeout(5_000) });
        const plugins = await state.json();
        nativePlugins = JSON.stringify(plugins.data?.filter(plugin => plugin.source?.type !== 'builtin' || plugin.state?.status !== 'active'))
          .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(0, 6000);
      } catch {}
    }
    return response;
  } catch (error) {
    nativeRequests.push({ pathname, error: error.name, milliseconds: Date.now() - started });
    throw error;
  }
};
let logged = false;
let searched = false;
let handoffPending = false;
let handoffIssued = false;
let discoveredPaths = [];
const direct = process.env.OPENCODE_TEST_DIRECT === '1';
const callsPath = join(root, 'mcp-calls.jsonl');
const plugin = join(root, 'fixture-plugin'); mkdirSync(plugin);
writeFileSync(join(plugin, 'index.js'), `export default {id:'borg.native-fixture.tools',async setup(ctx){
  await ctx.tool.transform(editor => { editor.update('shell', tool => { tool.options = {...tool.options, codemode:true}; }); });
}};`);
const userPlugin = join(root, 'user-plugin'); mkdirSync(userPlugin);
writeFileSync(join(userPlugin, 'index.js'), `export default {id:'borg.native-fixture.user',async setup(ctx){ await ctx.session.hook('context',event=>event.system.push({type:'text',text:'Fixture user plugin survived'})); }};`);
mkdirSync(join(root, '.config', 'opencode'), {recursive:true});
const userConfigPath = join(root, '.config', 'opencode', 'opencode.jsonc');
const userConfig = v1Binary
  ? '{// Shared V1-readable user configuration\n"$schema":"https://opencode.ai/config.json","permission":{"borg_borg_*":"ask"},"mcp":{"borg":' + JSON.stringify({ type: 'local', command: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), join(root, 'v1-mcp-calls.jsonl')], environment: { BORG_AGENT_KIND: 'opencode' } }) + '}}\n'
  : '{// User configuration must survive the launch\n"plugins":' + JSON.stringify([userPlugin]) + ',"permissions":[{"action":"borg_borg_*","resource":"*","effect":"ask"}]' + (direct ? ',"mcp":{"servers":{"borg":{"type":"local","command":["user-borg-placeholder"],"codemode":false}}}' : '') + '}\n';
writeFileSync(userConfigPath, userConfig);
const provider = createServer(async (req, res) => {
  configuredProviderCredential &&= req.headers.authorization === 'Bearer fixture';
  let input = ''; for await (const chunk of req) input += chunk;
  const body = JSON.parse(input); requests.push(body);
  const system = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  for (const message of body.messages.filter(message=>message.role==='tool')) {
    try { const value = JSON.parse(message.content); for (const catalog of [value, value.borg, value.shell]) if (Array.isArray(catalog?.items)) discoveredPaths.push(...catalog.items.map(item=>item.path)); } catch {}
  }
  const advertisedPaths = [...system.matchAll(/- (tools\.[^\n(]+)\(/g)].map(match => match[1]);
  const borgPaths = [...new Set([...advertisedPaths, ...discoveredPaths])].filter(name => /^tools\.borg[.[]/.test(name));
  const paths = borgPaths.filter(name=>name.includes('borg_read-log') || name.includes('borg_roster'));
  const logPath = borgPaths.find(name=>/(?:\.borg_log|\["borg_log"\])$/.test(name));
  if (process.env.OPENCODE_TEST_TRACE === '1') console.log(JSON.stringify({ paths: [...system.matchAll(/tools\.[^\n(]+\(/g)].map(match => match[0]), direct: body.tools?.map(tool => tool.function?.name) }));
  const directNames = body.tools?.map(tool => tool.function?.name).filter(name => ['borg_borg_read-log','borg_borg_roster'].includes(name)) ?? [];
  const shellPath = [...advertisedPaths, ...discoveredPaths].find(name => /(?:\.shell|\["shell"\])$/.test(name));
  const shellCode = shellPath ? `for (let i=0;i<3;i++) await ${shellPath}({command:'echo fixture',description:'Local fixture'});` : '';
  if (process.env.OPENCODE_TEST_TRACE === '1') console.log(JSON.stringify({ shellPath, result: body.messages.filter(message=>message.role==='tool') }));
  let toolCalls = [];
  const actionIndex = requests.length - (searched ? 1 : 0);
  if (!searched && system.includes('catalog is partial') && (paths.length < 2 || !shellPath || (realSeat && !logPath))) {
    searched = true;
    toolCalls = [{index:0,id:'fixture-search',type:'function',function:{name:'execute',arguments:JSON.stringify({code:'return {borg:search({namespace:"tools.borg",limit:100}),shell:search({query:"shell",limit:100})};'})}}];
  }
  else if (actionIndex === 1 && directNames.length >= 2) toolCalls = directNames.slice(0,2).map((name,index) => ({index,id:'direct-'+index,type:'function',function:{name,arguments:'{}'}}));
  else if ((actionIndex === 1 && paths.length >= 2) || (direct && actionIndex === 2)) toolCalls = [{index:0,id:'fixture-execute',type:'function',function:{name:'execute',arguments:JSON.stringify({code: `${direct ? '' : `const results = await Promise.all([${paths.slice(0,2).map(name=>`${name}({})`).join(',')}]);`} ${shellCode} return 'compact fixture result';`})}}];
  else if (realSeat && logPath && !logged && system.includes('3+ state-changing')) {
    logged = true;
    toolCalls = [{index:0,id:'fixture-log',type:'function',function:{name:'execute',arguments:JSON.stringify({code:`return await ${logPath}({message:'Native OpenCode V2 fixture persisted log',to:'broadcast'});`})}}];
  }
  if (handoffPending && !handoffIssued) {
    handoffIssued = true;
    const name = directNames.find(name => name.includes('read-log'));
    const api = paths.find(name => name.includes('read-log'));
    assert.ok(direct ? name : api, 'Human session discovers Borg read tool');
    toolCalls = [{ index: 0, id: 'human-handoff-read', type: 'function', function: direct
      ? { name, arguments: '{}' } : { name: 'execute', arguments: JSON.stringify({ code: `return await ${api}({});` }) } }];
  }
  const shouldCall = toolCalls.length > 0;
  providerSteps.push({ actionIndex, paths, logPath, shellPath,
    nudge: /Heads up: (\d+)\+ state-changing/.exec(system)?.[1],
    discoveredPaths: [...discoveredPaths], calls: toolCalls.map(call => call.function.name),
    toolResults: body.messages.filter(message => message.role === 'tool').map(message =>
      String(message.content).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(0, 1500)) });
  res.setHeader('Content-Type', 'text/event-stream');
  for (const chunk of [
    { choices: [{ index: 0, delta: shouldCall ? { role: 'assistant', tool_calls: toolCalls } : { role: 'assistant', content: 'Fixture complete.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: shouldCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'model', ...chunk })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
let launch;
try {
  const { inspectOpenCodeInstallation } = await import('../../dist/opencode-installation.js');
  const { launchOpenCodeV2Process } = await import('../../dist/opencode-v2-launch.js');
  const { readOpenCodeV2Descriptor, readOpenCodeV2PluginDescriptor, callOpenCodeV2Broker } = await import('../../dist/opencode-v2-broker.js');
  const { openCodePrivateRoot } = await import('../../dist/opencode-private-state.js');
  let nativeClient;
  let nativeRootHeaders;
  let nativeRootURL;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BORG_STATE_ROOT: root,
    ...(realSeat ? { BORG_SERVER_DATA_DIR: process.env.BORG_SERVER_DATA_DIR } : {}),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: 'disable', snapshots: false, model: 'borg-fixture/model',
      plugins: [plugin, ...(v1Binary ? [userPlugin] : [])],
      providers: { 'borg-fixture': { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture' },
        models: { model: { name: 'Fixture', limit: { context: 32000, output: 1024 } } } } } }) };
  const installation = inspectOpenCodeInstallation(env, { resolveExecutable: () => realpathSync(binary),
    readVersion: executable => { const { execFileSync } = process.getBuiltinModule('child_process'); return execFileSync(executable, ['--version'], { encoding: 'utf8', env }); } });
  let tui;
  const subdirectory = join(directory, 'fixture-src'); mkdirSync(subdirectory, { recursive: true });
  const launchOptions = { installation, cwd: subdirectory, env, prompt: 'Local integration fixture',
    ...(realSeat ? {} : { mcpCommand: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), callsPath] }),
    seat: { worktree: directory, droneId: process.env.OPENCODE_TEST_DRONE_ID ?? 'fixture-drone', cubeId: process.env.OPENCODE_TEST_CUBE_ID ?? 'fixture-cube' },
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, realpathSync(binary)); assert.ok(args.includes('--server')); assert.ok(!args.includes('--prompt'));
      assert.ok(options.env.OPENCODE_PASSWORD); assert.equal(options.cwd, directory);
      nativeRootHeaders = { Authorization: 'Basic ' + Buffer.from('opencode:' + options.env.OPENCODE_PASSWORD).toString('base64') };
      nativeRootURL = args[args.indexOf('--server') + 1];
      tui = new EventEmitter(); tui.kill = () => { tui.emit('exit', 0); tui.emit('close', 0); return true; };
      void (async () => {
        const { OpenCode } = await import('@opencode/client');
        const client = OpenCode.make({ baseUrl: args[args.indexOf('--server') + 1], headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + options.env.OPENCODE_PASSWORD).toString('base64') },
          fetch: (input, init) => fetch(input, {...init, signal: init?.signal ?? AbortSignal.timeout(15_000)}) });
        nativeClient = client;
        for (let i = 0; i < 100; i++) {
          const mcp = await client.mcp.list({ location: { directory } });
          if (mcp.data.find(item => item.name === 'borg')?.status.status === 'connected') { tui.emit('spawn'); return; }
          if (i === 99) { console.error(JSON.stringify(mcp)); tui.emit('error', new Error('Fixture MCP did not connect')); return; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })().catch(error => tui.emit('error', error)); return tui;
    } };
  launch = await launchOpenCodeV2Process(launchOptions);
  const descriptorPath = join(openCodePrivateRoot(), readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name)));
  const descriptor = readOpenCodeV2Descriptor(descriptorPath);
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  assert.ok(requests.length, 'Fixture provider received a generation');
  assert.ok(configuredProviderCredential, 'Configured provider credentials remain available in the isolated database');
  const modelInput = JSON.stringify(requests);
  for (const hidden of [descriptor.capability, 'borgOpenCodeInjectedEntry', 'borgOpenCodeWakeIdentity']) {
    assert.ok(!modelInput.includes(hidden), 'Broker credentials and admission metadata stay out of model input');
  }
  assert.ok(JSON.stringify(requests[0].messages).includes('Fixture user plugin survived'));
  assert.equal(readFileSync(userConfigPath, 'utf8'), userConfig);
  console.log(JSON.stringify({ version: installation.version, requests: requests.length, tools: requests.at(-1).tools?.map(tool => tool.function?.name),
    status: await callOpenCodeV2Broker(descriptor, '/status') }));
  assert.ok(!readFileSync(descriptorPath, 'utf8').includes('OPENCODE_PASSWORD'));
  if (!realSeat) {
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.name).sort(), ['borg_read-log', 'borg_roster']);
    assert.ok(calls.every(call => call.meta?.['ai.opencode/sessionID'] === descriptor.sessionID));
    assert.ok((await callOpenCodeV2Broker(descriptor, '/context', { sessionID: descriptor.sessionID })).text.includes('3+ state-changing'), 'Nested shell operations counted once each');
    await callOpenCodeV2Broker(descriptor, '/logged', { sessionID: descriptor.sessionID });
  } else {
    if (!logged) {
      assert.ok((await callOpenCodeV2Broker(descriptor, '/context', { sessionID: descriptor.sessionID })).text.includes('3+ state-changing'),
        'Real Borg reads and nested shell operations completed before the audit follow-up');
      // A follow-up prompt also covers hosts that refresh context only at
      // the next generation boundary.
      await callOpenCodeV2Broker(descriptor, '/wake', { key: 'audit-followup', text: 'Local audit follow-up', source: 'audit-followup' });
      await nativeClient.session.wait({ sessionID: descriptor.sessionID });
    }
    assert.ok(logged, 'Actual Borg MCP persisted a log after the native nested audit nudge');
  }
  assert.ok(!(await callOpenCodeV2Broker(descriptor, '/context', { sessionID: descriptor.sessionID })).text.includes('Heads up:'));
  const wake = await callOpenCodeV2Broker(descriptor, '/wake', { key:'wake-fixture', text:'Local wake fixture', source:'source-fixture' });
  const duplicate = await callOpenCodeV2Broker(descriptor, '/wake', { key:'wake-fixture-reping', text:'Local wake fixture', source:'source-fixture' });
  assert.equal(duplicate.id, wake.id);
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  await nativeClient.session.compact({ sessionID: descriptor.sessionID });
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('generated declarations'), 'Compaction retains Borg orientation and Code Mode guidance');
  if (!realSeat) {
    // Two actual native hosts share the ordinary user config/data while their
    // worktrees, API credentials, plugin environments, and broker seats differ.
    const otherDirectory = join(root, 'second-worktree'); mkdirSync(otherDirectory);
    // A complete project entry replaces all optional fields from the global
    // entry; direct mode above supplied an explicit global codemode=false.
    writeFileSync(join(otherDirectory, 'opencode.json'), JSON.stringify({ mcp: { servers: { borg: { type: 'local', command: ['project-placeholder'], environment: { BORG_FIXTURE_PROJECT: 'winner' } } } } }));
    let otherURL;
    let otherHeaders;
    let otherVerificationKey;
    const otherSeat = { worktree: otherDirectory, droneId: 'second-fixture-drone', cubeId: 'fixture-cube' };
    const other = await launchOpenCodeV2Process({ installation, cwd: otherDirectory, env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: '0' },
      prompt: 'Concurrent native host fixture', seat: otherSeat,
      mcpCommand: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), join(root, 'other-mcp-calls.jsonl')],
      spawnProcess: (_executable, args, options) => {
        otherVerificationKey = options.env.BORG_OPENCODE_V2_VERIFICATION_KEY;
        otherURL = args[args.indexOf('--server') + 1];
        otherHeaders = { Authorization: 'Basic ' + Buffer.from('opencode:' + options.env.OPENCODE_PASSWORD).toString('base64') };
        const child = new EventEmitter(); child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
        queueMicrotask(() => child.emit('spawn')); return child;
      } });
    try {
      const otherDescriptorPath = readdirSync(openCodePrivateRoot()).map(name => join(openCodePrivateRoot(), name))
        .find(filename => filename !== descriptorPath && /opencode-v2-[\w-]{43}\.json$/.test(filename));
      const otherDescriptor = readOpenCodeV2Descriptor(otherDescriptorPath);
      const otherPlugin = readOpenCodeV2PluginDescriptor(otherDescriptorPath + '.plugin', otherVerificationKey);
      const preserved = await callOpenCodeV2Broker(otherPlugin, '/mcp-options');
      assert.deepEqual(preserved, { environment: { BORG_FIXTURE_PROJECT: 'winner' } }, 'Whole winning project entry replaces global MCP options');
      assert.notEqual(otherDescriptor.url, descriptor.url); assert.notEqual(otherDescriptor.capability, descriptor.capability);
      assert.notEqual(otherDescriptor.sessionID, descriptor.sessionID);
      assert.equal((await fetch(`${otherURL}/api/info`, { headers: nativeRootHeaders })).status, 401);
      assert.equal((await fetch(`${otherURL}/api/info`, { headers: otherHeaders })).status, 200);
      await assert.rejects(callOpenCodeV2Broker(otherDescriptor, '/bind', { seat: descriptor.seat }));
      assert.equal((await callOpenCodeV2Broker(descriptor, '/status')).sessionID, descriptor.sessionID);
      assert.equal(readFileSync(userConfigPath, 'utf8'), userConfig);
    } finally { other.process.kill(); await other.cleanup(); }
    assert.ok((await callOpenCodeV2Broker(descriptor, '/status')).pluginReady, 'Closing the other host leaves this host active');
  }
  if (v1Binary) {
    const { installLaunchOpenCodePlugin } = await import('../../dist/opencode-launch-plugin.js');
    const { allocateOpenCodePort } = await import('../../dist/opencode-drone.js');
    const correlation = randomBytes(32).toString('base64url');
    const v1Plugin = installLaunchOpenCodePlugin(1, correlation);
    const v1Directory = join(root, 'v1-worktree'); mkdirSync(v1Directory);
    const port = await allocateOpenCodePort();
    const authorization = { Authorization: 'Basic ' + Buffer.from('opencode:v1-fixture').toString('base64') };
    const child = spawn(v1Binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: v1Directory, stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'),
        BORG_SESSION: '1', BORG_OPENCODE_LAUNCH_CORRELATION: correlation,
        OPENCODE_SERVER_PASSWORD: 'v1-fixture', OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, plugin: [v1Plugin.entrypoint] }) } });
    const closed = new Promise(resolve => child.once('close', resolve));
    let v1Error = ''; child.stderr.on('data', chunk => { v1Error = (v1Error + chunk).slice(-4096); });
    child.on('error', () => {});
    const request = async (pathname, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: body ? 'POST' : 'GET',
        headers: { ...authorization, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(3000) });
      assert.ok(response.ok, `Concurrent V1 request ${pathname}: ${response.status}`); return response.json();
    };
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { await request('/session'); ready = true; break; } catch {}
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'V1 starts while V2 owns a private server with the same user config/data: ' + v1Error.replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'));
      const session = await request('/session', {});
      assert.equal((await request('/mcp')).borg?.status, 'connected');
      await request(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Concurrent V1 fixture' }], noReply: true });
      const messages = await request(`/session/${session.id}/message`);
      assert.ok(messages.some(message => message.parts.some(part => part.metadata?.borgOpenCodeLaunchCorrelation === correlation)));
      assert.equal((await fetch(`http://127.0.0.1:${port}/session`, { headers: nativeRootHeaders })).status, 401);
      assert.equal((await fetch(`${nativeRootURL}/api/info`, { headers: authorization })).status, 401);
      assert.equal(readFileSync(userConfigPath, 'utf8'), userConfig);
    } finally {
      child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await closed; clearTimeout(timeout);
    }
    assert.ok((await callOpenCodeV2Broker(descriptor, '/status')).pluginReady, 'Closing V1 leaves the V2 launch active');
  }
  if (!realSeat) {
    const { SessionMessage } = await import('@opencode/schema/session-message');
    const { effectiveOpenCodeV2Permission } = await import('../../dist/opencode-v2-permissions.js');
    const human = await nativeClient.session.create({ location: { directory }, title: 'Human-selected Borg root' });
    const before = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    handoffPending = true;
    await nativeClient.session.prompt({ sessionID: human.id, id: SessionMessage.ID.create(), text: 'Human-selected session policy fixture' });
    await nativeClient.session.wait({ sessionID: human.id }, { signal: AbortSignal.timeout(20_000) });
    handoffPending = false;
    assert.equal((await callOpenCodeV2Broker(descriptor, '/status')).sessionID, human.id);
    const updated = await nativeClient.session.get({ sessionID: human.id });
    assert.equal(effectiveOpenCodeV2Permission(updated.permissions ?? [], 'borg_borg_read-log'), 'allow');
    const newCalls = readFileSync(callsPath, 'utf8').trim().split('\n').slice(before).map(line => JSON.parse(line));
    assert.ok(newCalls.some(call => call.name === 'borg_read-log' && call.meta?.['ai.opencode/sessionID'] === human.id), 'First Borg call in a human-selected root receives launch policy');
  }
  tui.kill(); await launch.cleanup(); launch = undefined;
  await assert.rejects(callOpenCodeV2Broker(descriptor, '/status'));
  if (!realSeat) {
    for (const passthroughArgs of [['--session', descriptor.sessionID], ['--continue']]) {
      launch = await launchOpenCodeV2Process({ ...launchOptions, passthroughArgs });
      const filename = readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name));
      const resumed = readOpenCodeV2Descriptor(join(openCodePrivateRoot(), filename));
      assert.equal(resumed.sessionID, descriptor.sessionID, 'Resume and continue use the persistent Borg V2 session');
      const message = await nativeClient.session.message.get({ sessionID: resumed.sessionID, messageID: wake.id });
      assert.equal(message.metadata.borgOpenCodeWakeIdentity, wake.id, 'Wake metadata survives compaction and native host restart');
      await nativeClient.session.wait({ sessionID: resumed.sessionID });
      tui.kill(); await launch.cleanup(); launch = undefined;
    }
    const { Session } = await import('@opencode/schema/session');
    const generatedBefore = requests.length;
    await assert.rejects(launchOpenCodeV2Process({ ...launchOptions, passthroughArgs: ['--session', Session.ID.create()] }), /could not be resumed/);
    assert.equal(requests.length, generatedBefore, 'A missing resume target never submits a replacement kickoff');
  }
} catch (error) {
  console.error(JSON.stringify({ nativeRequests: nativeRequests.slice(-12), nativePlugins, providerSteps: providerSteps.slice(-6) }));
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  await launch?.cleanup(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (!realSeat) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
