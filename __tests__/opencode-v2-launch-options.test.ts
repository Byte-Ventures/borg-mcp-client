import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveOpenCodeV2McpOptions } from '../src/opencode-v2-launch.js';
import { openCodeWorktreeDirectory } from '../src/opencode-private-state.js';
import { OPENCODE_V2_DESCRIPTOR_ENV } from '../src/opencode-v2-broker.js';

const document = entry => ({ type: 'document' as const, info: { mcp: { servers: { borg: { type: 'local', command: ['borg'], ...entry } } } } });
describe('OpenCode launch selection', () => {
  it('uses the whole winning user MCP entry, restoring the original inline source', () => {
    const global = document({ codemode: false, timeout: 123, protocol: 'auto', environment: { GLOBAL: '1' } });
    const project = document({ environment: { PROJECT: '1', OPENCODE_PASSWORD: 'secret' } });
    const owned = document({ environment: { [OPENCODE_V2_DESCRIPTOR_ENV]: '/private/launch' } });
    expect(preserveOpenCodeV2McpOptions([global, project, owned] as any, '/private/launch')).toEqual({ environment: { PROJECT: '1' } });
    expect(preserveOpenCodeV2McpOptions([global, owned] as any, '/private/launch')).toEqual({ codemode: false, timeout: 123, protocol: 'auto', environment: { GLOBAL: '1' } });
    const inline = JSON.stringify({ mcp: { servers: { borg: { type: 'local', command: ['inline'], codemode: true, environment: { INLINE: '1' } } } } });
    expect(preserveOpenCodeV2McpOptions([global, project, owned] as any, '/private/launch', inline)).toEqual({ codemode: true, environment: { INLINE: '1' } });
  });

  it('normalizes physical descendants to the selected worktree and rejects siblings and symlink escapes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-oc-ancestry-')));
    try {
      const worktree = join(root, 'worktree'); const child = join(worktree, 'src');
      const outside = join(root, 'worktree-other'); mkdirSync(child, { recursive: true }); mkdirSync(outside);
      expect(openCodeWorktreeDirectory(child, worktree)).toBe(worktree);
      expect(() => openCodeWorktreeDirectory(outside, worktree)).toThrow('within');
      const link = join(worktree, 'escape'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => openCodeWorktreeDirectory(link, worktree)).toThrow('within');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
