// Invoked explicitly with a published native binary; never contacts a model provider.
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
let losePromptResponse = false;
let lostPromptResponses = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
  const started = Date.now();
  try {
    const response = await originalFetch(input, init);
    nativeRequests.push({ pathname, status: response.status, milliseconds: Date.now() - started });
    if (losePromptResponse && /\/api\/session\/[^/]+\/prompt$/.test(pathname) && response.ok) {
      losePromptResponse = false; lostPromptResponses++;
      await response.arrayBuffer();
      throw new Error('Fixture lost native response after admission');
    }
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
let audienceRequested = false;
let audienceIssued = false;
let failNextGeneration = false;
let holdNextGeneration = false;
let releaseGeneration;
let direct = process.env.OPENCODE_TEST_DIRECT === '1';
let nativeScenario;
const nativeEvidence = [];
const pluginDelayMs = Number(process.env.OPENCODE_TEST_PLUGIN_DELAY_MS ?? 0);
assert.ok(Number.isInteger(pluginDelayMs) && pluginDelayMs >= 0 && pluginDelayMs < 60_000, 'Invalid fixture plugin delay');
const callsPath = join(root, 'mcp-calls.jsonl');
const environmentPath = join(root, 'mcp-environment.jsonl');
function assertMaterializedWake(rows, nonTargetRows, delivery, text) {
  const matches = rows.filter(row => row.type === 'user' && row.text === text);
  assert.equal(matches.length, 1, 'One materialized user input, not merely an HTTP admission');
  assert.equal(matches[0].id, delivery.id);
  assert.equal(matches[0].metadata?.borgOpenCodeWakeIdentity, delivery.id);
  assert.ok(!nonTargetRows.some(row => row.type === 'user' && row.text === text), 'Wake does not reach the non-target session');
}
function checkMaterializationControls(rows, nonTargetRows, delivery, text) {
  assertMaterializedWake(rows, nonTargetRows, delivery, text);
  const message = rows.find(row => row.id === delivery.id);
  // Corrupt actual host observations, not expected outputs: every check must
  // reject loss, duplication, missing identity, and a wrong-target copy.
  assert.throws(() => assertMaterializedWake(rows.filter(row => row.id !== delivery.id), nonTargetRows, delivery, text));
  assert.throws(() => assertMaterializedWake([...rows, message], nonTargetRows, delivery, text));
  assert.throws(() => assertMaterializedWake(rows.map(row => row.id === delivery.id ? { ...row, metadata: {} } : row), nonTargetRows, delivery, text));
  assert.throws(() => assertMaterializedWake(rows, [...nonTargetRows, message], delivery, text));
}
const valuePath = join(root, 'inline-value.txt'); writeFileSync(valuePath, 'native-file-expanded');
const plugin = join(root, 'fixture-plugin'); mkdirSync(plugin);
writeFileSync(join(plugin, 'index.js'), `export default {id:'borg.native-fixture.tools',async setup(ctx){
  await new Promise(resolve => setTimeout(resolve, ${pluginDelayMs}));
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
  if (failNextGeneration) {
    failNextGeneration = false;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Fixture asynchronous processing failure', type: 'invalid_request_error' } }));
    return;
  }
  if (holdNextGeneration) {
    holdNextGeneration = false;
    await new Promise(resolve => { releaseGeneration = resolve; });
    releaseGeneration = undefined;
  }
  const system = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  for (const message of body.messages.filter(message=>message.role==='tool')) {
    try { const value = JSON.parse(message.content); for (const catalog of [value, value.borg, value.shell]) if (Array.isArray(catalog?.items)) discoveredPaths.push(...catalog.items.map(item=>item.path)); } catch {}
  }
  const advertisedPaths = [...system.matchAll(/- (tools\.[^\n(]+)\(/g)].map(match => match[1]);
  const borgPaths = [...new Set([...advertisedPaths, ...discoveredPaths])].filter(name => /^tools\.borg[.[]/.test(name));
  const paths = borgPaths.filter(name=>name.includes('borg_read_log') || name.includes('borg_roster'));
  const orientationPaths = ['borg_role', 'borg_playbook'].map(tool => borgPaths.find(name => name.endsWith('.' + tool) || name.endsWith('["' + tool + '"]')));
  const logPath = borgPaths.find(name=>/(?:\.borg_log|\["borg_log"\])$/.test(name));
  if (process.env.OPENCODE_TEST_TRACE === '1') console.log(JSON.stringify({ paths: [...system.matchAll(/tools\.[^\n(]+\(/g)].map(match => match[0]), direct: body.tools?.map(tool => tool.function?.name) }));
  const directNames = body.tools?.map(tool => tool.function?.name).filter(name => ['borg_borg_read_log','borg_borg_roster'].includes(name)) ?? [];
  const shellPath = [...advertisedPaths, ...discoveredPaths].find(name => /(?:\.shell|\["shell"\])$/.test(name));
  const shellCode = shellPath ? `for (let i=0;i<3;i++) await ${shellPath}({command:'echo fixture',description:'Local fixture'});` : '';
  if (process.env.OPENCODE_TEST_TRACE === '1') console.log(JSON.stringify({ shellPath, result: body.messages.filter(message=>message.role==='tool') }));
  let toolCalls = [];
  const actionIndex = requests.length - (searched ? 1 : 0);
  if (!searched && system.includes('catalog is partial') && (paths.length < 2 || orientationPaths.some(path => !path) || !shellPath || (!direct && !logPath))) {
    searched = true;
    toolCalls = [{index:0,id:'fixture-search',type:'function',function:{name:'execute',arguments:JSON.stringify({code:'return {borg:search({namespace:"tools.borg",limit:100}),shell:search({query:"shell",limit:100})};'})}}];
  }
  else if (actionIndex === 1 && directNames.length >= 2) toolCalls = directNames.slice(0,2).map((name,index) => ({index,id:'direct-'+index,type:'function',function:{name,arguments:'{}'}}));
  else if ((actionIndex === 1 && paths.length >= 2) || (direct && actionIndex === 2)) toolCalls = [{index:0,id:'fixture-execute',type:'function',function:{name:'execute',arguments:JSON.stringify({code: `${direct ? '' : `${orientationPaths.filter(Boolean).map(name => `await ${name}({});`).join(' ')} const results = await Promise.all([${paths.slice(0,2).map(name=>`${name}({})`).join(',')}]);`} ${shellCode} return 'compact fixture result';`})}}];
  else if (realSeat && logPath && !logged && system.includes('3+ state-changing')) {
    logged = true;
    toolCalls = [{index:0,id:'fixture-log',type:'function',function:{name:'execute',arguments:JSON.stringify({code:`return await ${logPath}({message:'Native OpenCode V2 fixture persisted log',to:'broadcast'});`})}}];
  }
  if (audienceRequested && !audienceIssued) {
    const logTool = body.tools?.find(tool => tool.function?.name === 'borg_borg_log');
    assert.ok(direct ? logTool : logPath, 'Native host advertises the real audience tool');
    // Inspect the actual provider-facing definition, not a simulated serializer.
    const representation = direct ? JSON.stringify(logTool.function) : system + JSON.stringify(body.messages.filter(message => message.role === 'tool'));
    assert.ok(representation.includes('even for one recipient'), 'Audience explanation survives native serialization');
    const audiences = ['broadcast', ['Build'], ['Build', 'Review']];
    audienceIssued = true;
    toolCalls = direct
      ? audiences.map((to, index) => ({ index, id: 'audience-' + index, type: 'function', function: {
          name: logTool.function.name, arguments: JSON.stringify({ message: 'Native audience fixture', to }),
        } }))
      : [{ index: 0, id: 'audience-code', type: 'function', function: { name: 'execute', arguments: JSON.stringify({
          code: `for (const to of ${JSON.stringify(audiences)}) await ${logPath}({message:'Native audience fixture',to}); return 'audience fixture complete';`,
        }) } }];
  }
  if (handoffPending && !handoffIssued) {
    handoffIssued = true;
    const name = directNames.find(name => name.includes('borg_read_log'));
    const api = paths.find(name => name.includes('borg_read_log'));
    assert.ok(direct ? name : api, 'Human session discovers Borg read tool');
    toolCalls = [{ index: 0, id: 'human-handoff-read', type: 'function', function: direct
      ? { name, arguments: '{}' } : { name: 'execute', arguments: JSON.stringify({ code: `return await ${api}({});` }) } }];
  }
  if (nativeScenario) {
    toolCalls = [];
    const scenario = nativeScenario;
    scenario.advertised = body.tools?.map(tool => tool.function?.name) ?? [];
    if (!scenario.issued) {
      const dispatcher = borgPaths.find(name => /(?:\.borg_tool|\["borg_tool"\])$/.test(name));
      if (scenario.kind === 'dispatcher' && !direct && !dispatcher) {
        assert.ok(!scenario.searched, 'Real Borg dispatcher must be discoverable');
        scenario.searched = true;
        toolCalls = [{ index: 0, id: scenario.id + '-search', type: 'function', function: {
          name: 'execute', arguments: JSON.stringify({ code: 'return search({namespace:"tools.borg",query:"borg_tool",limit:100});' }),
        } }];
      } else {
        scenario.issued = true;
        const inner = scenario.error ? { message: 42, to: 'broadcast' } : { message: scenario.message, to: 'broadcast' };
        const name = scenario.kind === 'dispatcher' && direct ? 'borg_borg_tool' : 'execute';
        const code = scenario.kind === 'dispatcher'
          ? `return await ${dispatcher}({name:'borg_log',arguments:${JSON.stringify(inner)}});`
          : `return await ${shellPath}({command:${JSON.stringify(scenario.command)},description:'Native permission side-effect proof'});`;
        if (scenario.kind !== 'dispatcher') assert.ok(shellPath, 'Previously discovered native shell path is available');
        toolCalls = [{ index: 0, id: scenario.id, type: 'function', function: { name,
          arguments: JSON.stringify(name === 'execute' ? { code } : { name: 'borg_log', arguments: inner }),
        } }];
        scenario.attempt = { name, arguments: toolCalls[0].function.arguments };
      }
    }
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
  let recoveryBystander;
  let nativeRootHeaders;
  let nativeRootURL;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BORG_STATE_ROOT: root,
    ...(realSeat ? { BORG_SERVER_DATA_DIR: process.env.BORG_SERVER_DATA_DIR } : {}),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    BORG_FIXTURE_INPUT: 'native-env-expanded',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: 'disable', snapshots: false, model: 'borg-fixture/model',
      plugins: [plugin, ...(v1Binary ? [userPlugin] : [])],
      ...(!realSeat ? { mcp: { servers: { borg: { type: 'local', command: ['user-placeholder'], codemode: !direct, environment: {
        BORG_FIXTURE_VALUE: '{env:BORG_FIXTURE_INPUT}', BORG_FIXTURE_FILE: `{file:${valuePath}}`,
        OPENCODE_PASSWORD: 'must-not-reach-mcp', OPENCODE_SERVER_PASSWORD: 'must-not-reach-mcp',
      } } } } } : {}),
      providers: { 'borg-fixture': { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture' },
        models: { model: { name: 'Fixture', limit: { context: 32000, output: 1024 } } } } } }) };
  const installation = inspectOpenCodeInstallation(env, { resolveExecutable: () => realpathSync(binary),
    readVersion: executable => { const { execFileSync } = process.getBuiltinModule('child_process'); return execFileSync(executable, ['--version'], { encoding: 'utf8', env }); } });
  let tui;
  const subdirectory = join(directory, 'fixture-src'); mkdirSync(subdirectory, { recursive: true });
  const launchOptions = { installation, cwd: subdirectory, env, prompt: 'Local integration fixture',
    ...(realSeat ? {} : { mcpCommand: [process.execPath, resolve('test/fixtures/opencode-mcp.mjs'), callsPath, environmentPath] }),
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
    const environments = readFileSync(environmentPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(environments.length > 0);
    assert.ok(environments.every(value => value.value === 'native-env-expanded' && value.file === 'native-file-expanded' && value.rootPasswordPresent === false),
      'Borg receives native-expanded inline env/file values without root API credentials');
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.name).sort(), direct ? ['borg_read_log', 'borg_roster'] : ['borg_playbook', 'borg_read_log', 'borg_role', 'borg_roster']);
    if (!direct) assert.deepEqual(calls.slice(0, 3).map(call => call.name), ['borg_role', 'borg_playbook', 'borg_read_log']);
    assert.ok(calls.every(call => call.meta?.['ai.opencode/sessionID'] === descriptor.sessionID));
    assert.ok((await callOpenCodeV2Broker(descriptor, '/context', { sessionID: descriptor.sessionID })).text.includes('3+ state-changing'), 'Nested shell operations counted once each');
    await callOpenCodeV2Broker(descriptor, '/logged', { sessionID: descriptor.sessionID });
    audienceRequested = true;
    await callOpenCodeV2Broker(descriptor, '/wake', { key: 'audience-fixture', text: 'Exercise explicit audiences', source: 'audience-fixture' });
    await nativeClient.session.wait({ sessionID: descriptor.sessionID });
    const audienceCalls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.name === 'borg_log');
    assert.deepEqual(audienceCalls.map(call => call.audience), ['broadcast', ['Build'], ['Build', 'Review']],
      'Broadcast, single and multiple direct recipients survive native Code Mode/direct delivery');
    console.log(JSON.stringify({ audienceRepresentation: direct ? 'native-direct' : 'native-codemode', audiences: audienceCalls.map(call => call.audience) }));
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
  const contracts = { permissions: [], dispatcher: [] };
  const runNativeScenario = async (binding, scenario) => {
    const sessionID = binding.sessionID;
    const before = new Set((await nativeClient.message.list({ sessionID, limit: 100 })).data.map(row => row.id));
    nativeScenario = scenario;
    try {
      const admitted = await callOpenCodeV2Broker(binding, '/wake', { key: scenario.id, source: scenario.id, text: scenario.id });
      assert.equal(admitted.accepted, true, 'Scenario input admitted independently of tool outcome');
      await nativeClient.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
      assert.ok(scenario.issued && scenario.attempt, 'Provider actually attempted the selected native tool');
      const rows = (await nativeClient.message.list({ sessionID, limit: 100 })).data.filter(row => !before.has(row.id));
      const tools = rows.flatMap(row => row.type === 'assistant' ? row.content.filter(part => part.type === 'tool') : []);
      const result = tools.find(tool => tool.name === scenario.attempt.name);
      assert.ok(result, 'Native history records the attempted tool outcome');
      nativeEvidence.push({ id: scenario.id, tool: result.name, status: result.state.status,
        error: result.state.error, content: result.state.content,
        nested: result.state.metadata?.toolCalls?.map(row => ({ tool: row.tool, status: row.status })) });
      return { result, admitted, advertised: scenario.advertised };
    } finally { nativeScenario = undefined; }
  };
  const proveDispatcher = async (binding, mode) => {
    let successful;
    const assertError = result => {
      assert.ok(result.state.status === 'error' || result.state.metadata?.toolCalls?.some(row => row.status === 'error' || row.status === 'failed'),
        'Actual Borg isError response remains an outer or nested tool error, independently of execute completion');
      assert.match(JSON.stringify(result.state), /message is required/, 'Real inner borg_log validation rejects the message type');
    };
    for (const error of [false, true]) {
      const id = `native-dispatcher-${mode}-${error ? 'error' : 'success'}`;
      const scenario = { id, kind: 'dispatcher', error, message: id };
      const { result } = await runNativeScenario(binding, scenario);
      if (error) {
        assertError(result);
        assert.throws(() => assertError(successful), 'Actual successful tool result cannot satisfy the error assertion');
        contracts.dispatcher.push({ mode, outcome: 'error', status: result.state.status });
      } else {
        assert.equal(result.state.status, 'completed');
        successful = result;
        const text = result.state.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        const entry = /(?:"id"\s*:\s*"|entry id: )([0-9a-f-]{36})/.exec(text)?.[1];
        assert.ok(entry, 'Real dispatcher returns a persisted log entry identity');
        contracts.dispatcher.push({ mode, outcome: 'success', entry, message: id });
      }
    }
  };
  if (realSeat) {
    const { applyOpenCodeV2LaunchPermissions } = await import('../../dist/opencode-v2-permissions.js');
    const sessionID = descriptor.sessionID;
    const original = (await nativeClient.session.get({ sessionID })).permissions ?? [];
    const marker = join(directory, 'native-permission-marker');
    const command = `echo native-permission-proof > '${marker.replace(/'/g, "'\\''")}'`;
    const assertDenied = result => {
      const detail = JSON.stringify(result.state);
      assert.ok(result.state.status === 'error' || /Unknown tool 'shell'/.test(detail),
        'Native outer error or unavailable nested shell refuses the attempted mutation');
      assert.equal(existsSync(marker), false, 'Denied outer/nested operation has no filesystem side effect');
    };
    try {
      for (const [label, execute, shell] of [['outer-deny', 'deny', 'allow'], ['nested-deny', 'allow', 'deny'], ['allowed', 'allow', 'allow']]) {
        assert.equal(existsSync(marker), false, 'No earlier attempt created the mutation marker');
        await nativeClient.session.update({ sessionID, permissions: [...original,
          { action: 'execute', resource: '*', effect: execute }, { action: 'shell', resource: '*', effect: shell },
        ] });
        // The operator selected preserved policy: unlike normal coordination
        // approvals, these denials must not be replaced by launch grants.
        await applyOpenCodeV2LaunchPermissions(nativeClient, sessionID, directory, true);
        const decisions = await Promise.all(['execute', 'shell'].map(action =>
          nativeClient.permission.create({ sessionID, agent: 'build', action, resources: ['*'] })));
        assert.deepEqual(decisions.map(row => row.effect), [execute, shell], 'Native effective policy retains the selected denials');
        const { result } = await runNativeScenario(descriptor, { id: `native-permission-${label}`, kind: 'mutation', command });
        if (label === 'allowed') {
          assert.equal(result.state.status, 'completed');
          assert.equal(readFileSync(marker, 'utf8').trim(), 'native-permission-proof', 'Allowed control executes the same mutation');
          assert.throws(() => assertDenied(result), 'Actual allowed mutation must fail the denial validator');
        } else {
          assertDenied(result);
          assert.match(JSON.stringify(result.state), /denied|No tool named .*currently available|not available|not found|unknown tool|not enabled/i,
            'Refusal is a native permission/tool-availability outcome, not an unrelated generation failure');
        }
        contracts.permissions.push({ case: label, decisions: decisions.map(row => row.effect), nativeStatus: result.state.status, mutated: existsSync(marker) });
      }
    } finally {
      await nativeClient.session.update({ sessionID, permissions: original });
      if (existsSync(marker)) rmSync(marker);
    }
    await proveDispatcher(descriptor, 'codemode');
  }
  if (realSeat) {
    // Failure injection belongs only to the existing CI-only isolated fleet.
    // Admission, materialization and model outcome are separate observations.
    const sessionID = descriptor.sessionID;
    const until = async (check, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Wake recovery timed out: ${label}`);
    };
    const inbox = () => nativeClient.session.inbox.list({ sessionID });
    const messages = async () => (await nativeClient.message.list({ sessionID, limit: 100 })).data;
    const bystander = await nativeClient.session.create({ location: { directory }, title: 'Wake recovery non-target' });
    recoveryBystander = bystander.id;
    const wakeInput = (key, source, text, resume = true) => ({ key, source, text, resume });
    const proof = async (delivery, text) => {
      const rows = await messages();
      const nonTargetRows = (await nativeClient.message.list({ sessionID: bystander.id, limit: 100 })).data;
      checkMaterializationControls(rows, nonTargetRows, delivery, text);
    };
    const lostText = 'Recovery response-lost input';
    losePromptResponse = true;
    const lost = await callOpenCodeV2Broker(descriptor, '/wake', wakeInput('lost-1', 'recovery-lost', lostText, false));
    assert.equal(lostPromptResponses, 1, 'Lost response control actually crossed native admission');
    assert.equal(lost.accepted, true);
    assert.equal(lost.delivered, false, 'Queued admission is not materialized input');
    const repeats = await Promise.all(['lost-2', 'lost-3'].map(key => callOpenCodeV2Broker(descriptor, '/wake', wakeInput(key, 'recovery-lost', lostText, false))));
    assert.ok(repeats.every(row => row.id === lost.id));
    const queued = (await inbox()).filter(row => row.id === lost.id);
    assert.equal(queued.length, 1, 'Concurrent retries retain exactly one native inbox item');
    assert.equal(queued[0].payload.metadata.borgOpenCodeWakeIdentity, lost.id);
    const rebound = await callOpenCodeV2Broker(descriptor, '/bind', { seat: descriptor.seat });
    assert.equal(rebound.sessionID, sessionID, 'MCP reconnect preserves target');

    // A blocked provider makes busy-session admission observable without sleeps
    // or assuming that steer inputs have FIFO model-processing semantics.
    holdNextGeneration = true;
    const busy = await callOpenCodeV2Broker(descriptor, '/wake', wakeInput('busy', 'recovery-busy', 'Recovery busy anchor'));
    await until(() => releaseGeneration, 'provider is processing the busy anchor');
    const burst = await Promise.all([0, 1, 2].map(index => callOpenCodeV2Broker(descriptor, '/wake',
      wakeInput(`burst-${index}`, `recovery-burst-${index}`, `Recovery burst ${index}`))));
    assert.ok(burst.every(row => row.accepted));
    assert.equal(new Set(burst.map(row => row.id)).size, 3);
    const replay = await callOpenCodeV2Broker(descriptor, '/wake', wakeInput('burst-reconnect', 'recovery-burst-1', 'Recovery burst 1'));
    assert.equal(replay.id, burst[1].id);
    const busyInbox = await inbox();
    const burstHostState = [];
    for (const delivery of burst) {
      const queued = busyInbox.filter(row => row.id === delivery.id);
      let message;
      try { message = await nativeClient.session.message.get({ sessionID, messageID: delivery.id }); } catch {}
      assert.ok(queued.some(row => row.payload.metadata?.borgOpenCodeWakeIdentity === delivery.id) ||
        (message?.type === 'user' && message.metadata?.borgOpenCodeWakeIdentity === delivery.id),
      'Busy admission must have matching native inbox/message evidence');
      burstHostState.push({ id: delivery.id, inboxCount: queued.length, materialized: message?.type === 'user' });
    }
    releaseGeneration();
    await nativeClient.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    await proof(lost, lostText);
    await proof(busy, 'Recovery busy anchor');
    for (const [index, delivery] of burst.entries()) await proof(delivery, `Recovery burst ${index}`);
    const observedOrder = (await messages()).filter(row => burst.some(delivery => delivery.id === row.id)).map(row => row.id);
    assert.equal(observedOrder.length, burst.length);
    const confirmed = await callOpenCodeV2Broker(descriptor, '/wake', { ...wakeInput('lost-confirm', 'recovery-lost', lostText), allowSubmit: false });
    assert.equal(confirmed.delivered, true);

    failNextGeneration = true;
    const failedText = 'Recovery processing-failure input';
    const beforeFailure = new Set((await messages()).map(row => row.id));
    const failed = await callOpenCodeV2Broker(descriptor, '/wake', wakeInput('processing-failure', 'recovery-processing-failure', failedText));
    assert.equal(failed.accepted, true);
    await nativeClient.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    assert.equal(failNextGeneration, false, 'Failure control reached the provider');
    await proof(failed, failedText);
    const outcome = await messages();
    const failureRows = outcome.filter(row => !beforeFailure.has(row.id));
    const assertProcessingFailure = rows => assert.ok(rows.some(row => row.type === 'assistant' && row.error),
      'Native history records asynchronous processing failure');
    assertProcessingFailure(failureRows);
    assert.throws(() => assertProcessingFailure(failureRows.map(({ error: _error, ...row }) => row)),
      'An admission or successful response cannot satisfy the processing-failure check');
    const failedDelivery = await callOpenCodeV2Broker(descriptor, '/wake', { ...wakeInput('failure-confirm', 'recovery-processing-failure', failedText), allowSubmit: false });
    assert.equal(failedDelivery.delivered, true, 'Delivered input does not assert successful model work');
    console.log(JSON.stringify({ wakeRecovery: { lostResponse: lost.id, busy: busy.id,
      burstAdmissionOrder: burst.map(row => row.id), observedMessageOrder: observedOrder,
      burstHostState,
      asynchronousFailure: failed.id, processingOutcome: 'native-assistant-error', target: sessionID,
      controls: 'loss/duplicate/identity/wrong-target/outcome rejected' } }));
  }
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
    const otherContent = JSON.parse(env.OPENCODE_CONFIG_CONTENT); delete otherContent.mcp;
    const otherSeat = { worktree: otherDirectory, droneId: 'second-fixture-drone', cubeId: 'fixture-cube' };
    const other = await launchOpenCodeV2Process({ installation, cwd: otherDirectory, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(otherContent), OPENCODE_DISABLE_PROJECT_CONFIG: '0' },
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
    const { applyOpenCodeV2LaunchPermissions } = await import('../../dist/opencode-v2-permissions.js');
    const sensitive = join(root, 'sensitive'); const scratch = join(root, 'scratch');
    mkdirSync(sensitive); mkdirSync(scratch);
    const sensitiveResource = sensitive.replace(/\\/g, '/') + '/*';
    const policySession = await nativeClient.session.create({ location: { directory }, title: 'Directory approval order fixture' });
    await nativeClient.session.update({ sessionID: policySession.id, permissions: [
      { action: 'external_directory', resource: sensitiveResource, effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
      { action: 'external_directory', resource: '*/private?/*', effect: 'deny' },
      { action: 'external_directory', resource: '*/private?/public/*', effect: 'allow' },
    ] });
    const checkPermission = resources => nativeClient.permission.create({ sessionID: policySession.id, agent: 'build', action: 'external_directory', resources });
    assert.equal((await checkPermission([sensitiveResource])).effect, 'ask');
    await applyOpenCodeV2LaunchPermissions(nativeClient, policySession.id, directory, true, [scratch]);
    assert.equal((await checkPermission([sensitiveResource])).effect, 'ask', 'Adding sibling scratch access preserves native approval for the sensitive directory');
    assert.equal((await checkPermission([scratch.replace(/\\/g, '/') + '/*'])).effect, 'allow');
    assert.equal((await checkPermission([scratch.replace(/\\/g, '/') + '/private1/*'])).effect, 'deny');
    assert.equal((await checkPermission([scratch.replace(/\\/g, '/') + '/private1/public/*'])).effect, 'allow');
    const human = await nativeClient.session.create({ location: { directory }, title: 'Human-selected Borg root' });
    const before = readFileSync(callsPath, 'utf8').trim().split('\n').length;
    handoffPending = true;
    await nativeClient.session.prompt({ sessionID: human.id, id: SessionMessage.ID.create(), text: 'Human-selected session policy fixture' });
    await nativeClient.session.wait({ sessionID: human.id }, { signal: AbortSignal.timeout(20_000) });
    handoffPending = false;
    assert.equal((await callOpenCodeV2Broker(descriptor, '/status')).sessionID, human.id);
    const updated = await nativeClient.session.get({ sessionID: human.id });
    assert.equal(effectiveOpenCodeV2Permission(updated.permissions ?? [], 'borg_borg_read_log'), 'allow');
    const newCalls = readFileSync(callsPath, 'utf8').trim().split('\n').slice(before).map(line => JSON.parse(line));
    assert.ok(newCalls.some(call => call.name === 'borg_read_log' && call.meta?.['ai.opencode/sessionID'] === human.id), 'First Borg call in a human-selected root receives launch policy');
  }
  if (realSeat) {
    // Kill only the native host created by this guarded CI fleet fixture.
    // Existing operator hosts and the Borg authority are never targeted.
    const sessionID = descriptor.sessionID;
    holdNextGeneration = true;
    const inFlight = await callOpenCodeV2Broker(descriptor, '/wake', {
      key: 'restart-in-flight', source: 'restart-in-flight', text: 'Recovery restart in-flight',
    });
    const deadline = Date.now() + 10_000;
    while (!releaseGeneration && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(releaseGeneration, 'Restart control observes an active native generation');
    const pending = await callOpenCodeV2Broker(descriptor, '/wake', {
      key: 'restart-pending', source: 'restart-pending', text: 'Recovery restart pending', resume: false,
    });
    assert.equal((await nativeClient.session.inbox.list({ sessionID })).filter(row => row.id === pending.id).length, 1,
      'Restart control observes the pending native inbox item before termination');
    assert.equal((await nativeClient.session.message.get({ sessionID, messageID: inFlight.id })).metadata.borgOpenCodeWakeIdentity, inFlight.id);
    process.kill(descriptor.server.pid, 'SIGKILL');
    releaseGeneration();
    await launch.cleanup(); launch = undefined;
    launch = await launchOpenCodeV2Process({ ...launchOptions, passthroughArgs: ['--session', sessionID] });
    const resumedFilename = readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name));
    const resumed = readOpenCodeV2Descriptor(join(openCodePrivateRoot(), resumedFilename));
    assert.equal(resumed.sessionID, sessionID);
    assert.notEqual(resumed.launch, descriptor.launch, 'Restart exercises a new broker generation');
    await nativeClient.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    const rows = (await nativeClient.message.list({ sessionID, limit: 100 })).data;
    const nonTargetRows = (await nativeClient.message.list({ sessionID: recoveryBystander, limit: 100 })).data;
    for (const [delivery, text] of [[inFlight, 'Recovery restart in-flight'], [pending, 'Recovery restart pending']]) {
      checkMaterializationControls(rows, nonTargetRows, delivery, text);
      assert.ok(!(await nativeClient.session.inbox.list({ sessionID })).some(row => row.id === delivery.id), 'Recovered input left the native inbox');
    }
    console.log(JSON.stringify({ wakeRestart: { sessionID, pending: pending.id, inFlight: inFlight.id, recovered: true } }));
  }
  if (realSeat) {
    tui.kill(); await launch.cleanup(); launch = undefined;
    // Reuse the fixture-owned isolated seat, not a second authority or a new CI
    // cell. The normal launch overlay still supplies the real Borg command.
    direct = true;
    const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    content.mcp = { servers: { borg: { type: 'local', command: ['user-placeholder'], codemode: false } } };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
    launch = await launchOpenCodeV2Process(launchOptions);
    const filename = readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name));
    const directBinding = readOpenCodeV2Descriptor(join(openCodePrivateRoot(), filename));
    await nativeClient.session.wait({ sessionID: directBinding.sessionID }, { signal: AbortSignal.timeout(15_000) });
    await proveDispatcher(directBinding, 'direct');
    console.log(JSON.stringify({ nativeContracts: contracts }));
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
    const legacyPolicyConfig = { ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), policies: [
      { action: 'tool.use', resource: 'borg_borg_read-log:*', effect: 'deny' },
    ] };
    await assert.rejects(launchOpenCodeV2Process({ ...launchOptions,
      env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(legacyPolicyConfig) },
    }), /tool-name migration required/, 'A legacy hard policy is refused before its target can disappear');
    assert.equal(requests.length, generatedBefore, 'A policy migration refusal never submits a kickoff');
    legacyPolicyConfig.policies.push({ action: 'tool.use', resource: 'borg_borg_read_log:*', effect: 'deny' });
    launch = await launchOpenCodeV2Process({ ...launchOptions,
      env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(legacyPolicyConfig) },
    });
    const pairedFilename = readdirSync(openCodePrivateRoot()).find(name => /^opencode-v2-[\w-]{43}\.json$/.test(name));
    const pairedDescriptor = readOpenCodeV2Descriptor(join(openCodePrivateRoot(), pairedFilename));
    for (const action of ['borg_borg_read-log', 'borg_borg_read_log']) {
      assert.equal((await nativeClient.permission.create({ sessionID: pairedDescriptor.sessionID, agent: 'build', action, resources: ['*'] })).effect,
        'deny', 'Native hard policies retain the same denial for the canonical name and its hidden alias');
    }
    tui.kill(); await launch.cleanup(); launch = undefined;
  }
  console.log(JSON.stringify({ version: installation.version, lifecycle: 'passed', pluginDelayMs,
    configurationMs: nativeRequests.filter(request => request.pathname === '/api/config').map(request => request.milliseconds) }));
} catch (error) {
  console.error(JSON.stringify({ nativeRequests: nativeRequests.slice(-12), nativePlugins, nativeEvidence, providerSteps: providerSteps.slice(-6) }));
  throw error;
} finally {
  releaseGeneration?.();
  globalThis.fetch = originalFetch;
  await launch?.cleanup(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); if (!realSeat) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
