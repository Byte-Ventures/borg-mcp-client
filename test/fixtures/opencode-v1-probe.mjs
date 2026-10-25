// Compatibility measurement of the retained V1 function plugin, without generation.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const binary = process.env.OPENCODE_TEST_V1_BINARY;
assert.ok(binary, 'Set OPENCODE_TEST_V1_BINARY');
const root = mkdtempSync(join(realpathSync(tmpdir()), 'borg-v1-native-'));
process.env.BORG_STATE_ROOT = root;
const { installLaunchOpenCodePlugin } = await import('../../dist/opencode-launch-plugin.js');
const { allocateOpenCodePort } = await import('../../dist/opencode-drone.js');
const identity = Buffer.alloc(32, 0x42).toString('base64url');
const port = await allocateOpenCodePort();
const plugin = installLaunchOpenCodePlugin(1, identity);
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, BORG_STATE_ROOT: root,
  XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  BORG_SESSION: '1', BORG_OPENCODE_LAUNCH_CORRELATION: identity,
  OPENCODE_SERVER_PASSWORD: 'fixture', OPENCODE_SERVER_USERNAME: 'opencode',
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, plugin: [plugin.entrypoint] }) };
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
const closed = new Promise(resolve => child.once('close', resolve));
const request = async (pathname, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from('opencode:fixture').toString('base64'), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
  assert.ok(response.ok, `${pathname}: ${response.status}`); return response.json();
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await request('/session'); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'V1 server readiness');
  const session = await request('/session', {});
  await request(`/session/${session.id}/message`, { parts: [{ type: 'text', text: 'Borg V1 plugin measurement' }], noReply: true });
  const messages = await request(`/session/${session.id}/message`);
  assert.ok(messages.some(message => message.parts.some(part => part.metadata?.borgOpenCodeLaunchCorrelation === identity)), 'V1 plugin attached the launch marker to durable history');
  console.log(JSON.stringify({ version: execFileSync(binary, ['--version'], { encoding: 'utf8', env }).trim(), plugin: 'function', metadata: 'persisted', generation: false }));
} finally {
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
}
