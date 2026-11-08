import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectOpenCodeInstallation } from '../src/opencode-installation';
import { startOpenCodeV2Server } from '../src/opencode-v2-server';

// Opt in with the path to an unpacked, published native CLI. This is a
// no-provider contract exercise, not the Borg wake/lifecycle matrix in #582.
const publishedBinary = process.env.OPENCODE_TEST_V2_BINARY;
describe.skipIf(!publishedBinary)('published OpenCode V2 private server', () => {
  it('proves authenticated ownership, plugin activation, duplicate admission, and EOF cleanup without model calls', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'borg-opencode-v2-contract-'));
    const config = join(root, 'config');
    const plugin = join(root, 'plugin');
    mkdirSync(config);
    mkdirSync(plugin);
    const bin = join(root, 'bin'); mkdirSync(bin);
    const executableAlias = join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (process.platform === 'win32') copyFileSync(publishedBinary!, executableAlias);
    else symlinkSync(realpathSync(publishedBinary!), executableAlias);
    writeFileSync(join(plugin, 'index.js'), `export default { id: 'borg.contract', async setup(ctx) {
      let calls = 0;
      await ctx.session.hook('prompt', event => {
        event.metadata = { ...event.metadata, hookCalls: ++calls,
          passwordVisible: Boolean(process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD) };
      });
    } };`);
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({ update: 'disable', snapshots: false, plugins: [plugin] }));
    const env = {
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TMPDIR: process.env.TMPDIR,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    };
    let server: Awaited<ReturnType<typeof startOpenCodeV2Server>> | undefined;
    try {
      const installed = inspectOpenCodeInstallation(env);
      const expected = realpathSync(executableAlias);
      expect(process.platform === 'win32' ? installed.executable.toLowerCase() : installed.executable)
        .toBe(process.platform === 'win32' ? expected.toLowerCase() : expected);
      server = await startOpenCodeV2Server({ installation: installed, directory: root, env });
      expect((await fetch(`${server.url}/api/info`)).status).toBe(401);
      const request = async (route: string, body?: unknown) => {
        const response = await fetch(`${server!.url}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...server!.headers(), 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const configEntries = await request('/api/config');
      expect(Array.isArray(configEntries)).toBe(true);
      const created = await request('/api/session', { location: { directory: root }, title: 'Borg contract test' });
      const prompt = { id: `msg_${randomBytes(12).toString('hex')}`, text: 'queued contract input', delivery: 'queue', resume: false };
      const first = await request(`/api/session/${created.data.id}/prompt`, prompt);
      const duplicate = await request(`/api/session/${created.data.id}/prompt`, prompt);
      expect(duplicate).toEqual(first);
      expect(first.data.payload.metadata).toEqual({ hookCalls: 1, passwordVisible: false });
      const inbox = await request(`/api/session/${created.data.id}/inbox`);
      expect(inbox.data).toHaveLength(1);
      const active = await request('/api/plugin');
      expect(active.data).toContainEqual(expect.objectContaining({ id: 'borg.contract', state: { status: 'active' } }));
      expect(created.data.tokens).toMatchObject({ input: 0, output: 0 });
      await server.close();
      await expect(fetch(`${server.url}/api/info`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
