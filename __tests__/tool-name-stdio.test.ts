import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('accepts hidden aliases over real MCP stdio while advertising only canonical names', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-alias-stdio-')));
  const client = new Client({ name: 'borg-alias-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
      HOME: root, USERPROFILE: root, BORG_STATE_ROOT: root, BORG_SESSION: '1', BORG_AGENT_KIND: 'claude', BORG_OPENCODE: '',
      XDG_CONFIG_HOME: join(root, '.config') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('borg_read_log');
    expect(names.every(name => !name.includes('-'))).toBe(true);
    const canonical = await client.callTool({ name: 'borg_describe_tool', arguments: { name: 'borg_read_log' } });
    const alias = await client.callTool({ name: 'borg_describe-tool', arguments: { name: 'borg_read-log' } });
    expect(alias).toEqual(canonical);
    expect((alias.structuredContent as any).name).toBe('borg_read_log');
    const direct = await client.callTool({ name: 'borg_read_log', arguments: { unread_only: true } });
    expect(await client.callTool({ name: 'borg_read-log', arguments: { unread_only: true } })).toEqual(direct);
    expect(await client.callTool({ name: 'borg_tool', arguments: { name: 'borg_read-log', arguments: { unread_only: true } } })).toEqual(direct);
    expect(direct.isError).toBe(true); // no saved seat; identity/authorization never inferred
    expect((await client.callTool({ name: 'borg_tool', arguments: { name: 'borg_describe-tool' } })).isError).toBe(true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
