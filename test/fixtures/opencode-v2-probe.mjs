// Invoked explicitly with a published native binary; never contacts a model provider.
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const binary = process.env.OPENCODE_TEST_V2_BINARY;
assert.ok(binary, 'Set OPENCODE_TEST_V2_BINARY');
const realSeat = Boolean(process.env.OPENCODE_TEST_SEAT_HOME);
if (realSeat) assert.ok(process.env.CI === 'true' && process.env.BORG_E2E === '1' && process.platform === 'linux');
const root = realSeat ? realpathSync(process.env.OPENCODE_TEST_SEAT_HOME) : mkdtempSync(join(realpathSync(tmpdir()), 'borg-v2-launch-'));
const directory = realSeat ? realpathSync(process.env.OPENCODE_TEST_SEAT_WORKTREE) : root;
process.env.BORG_STATE_ROOT = root;
const requests = [];
let logged = false;
let searched = false;
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
const userConfig = '{// User configuration must survive the launch\n"plugins":' + JSON.stringify([userPlugin]) + ',"permissions":[{"action":"borg_borg_*","resource":"*","effect":"ask"}]' + (direct ? ',"mcp":{"servers":{"borg":{"type":"local","command":["user-borg-placeholder"],"codemode":false}}}' : '') + '}\n';
writeFileSync(userConfigPath, userConfig);
const provider = createServer(async (req, res) => {
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
  const shouldCall = toolCalls.length > 0;
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
  const { readOpenCodeV2Descriptor, callOpenCodeV2Broker } = await import('../../dist/opencode-v2-broker.js');
  const { openCodePrivateRoot } = await import('../../dist/opencode-private-state.js');
  let nativeClient;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BORG_STATE_ROOT: root,
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: 'disable', snapshots: false, model: 'borg-fixture/model',
      plugins: [plugin],
      providers: { 'borg-fixture': { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture' },
        models: { model: { name: 'Fixture', limit: { context: 32000, output: 1024 } } } } } }) };
  const installation = inspectOpenCodeInstallation(env, { resolveExecutable: () => realpathSync(binary),
    readVersion: executable => { const { execFileSync } = process.getBuiltinModule('child_process'); return execFileSync(executable, ['--version'], { encoding: 'utf8', env }); } });
  let tui;
  launch = await launchOpenCodeV2Process({ installation, cwd: directory, env, prompt: 'Local integration fixture',
    ...(realSeat ? {} : { mcpCommand: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), callsPath] }),
    seat: { worktree: directory, droneId: process.env.OPENCODE_TEST_DRONE_ID ?? 'fixture-drone', cubeId: process.env.OPENCODE_TEST_CUBE_ID ?? 'fixture-cube' },
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, realpathSync(binary)); assert.ok(args.includes('--server')); assert.ok(!args.includes('--prompt'));
      assert.ok(options.env.OPENCODE_PASSWORD);
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
    } });
  const descriptorPath = join(openCodePrivateRoot(), readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name)));
  const descriptor = readOpenCodeV2Descriptor(descriptorPath);
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  assert.ok(requests.length, 'Fixture provider received a generation');
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
  } else assert.ok(logged, 'Actual Borg MCP persisted a log after the native nested audit nudge');
  assert.ok(!(await callOpenCodeV2Broker(descriptor, '/context', { sessionID: descriptor.sessionID })).text.includes('Heads up:'));
  const wake = await callOpenCodeV2Broker(descriptor, '/wake', { key:'wake-fixture', text:'Local wake fixture', source:'source-fixture' });
  const duplicate = await callOpenCodeV2Broker(descriptor, '/wake', { key:'wake-fixture', text:'Local wake fixture', source:'source-fixture' });
  assert.equal(duplicate.id, wake.id);
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  await nativeClient.session.compact({ sessionID: descriptor.sessionID });
  await nativeClient.session.wait({ sessionID: descriptor.sessionID });
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('generated declarations'), 'Compaction retains Borg orientation and Code Mode guidance');
  tui.kill(); await launch.cleanup(); launch = undefined;
  await assert.rejects(callOpenCodeV2Broker(descriptor, '/status'));
} finally {
  await launch?.cleanup(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (!realSeat) rmSync(root, { recursive: true, force: true });
}
