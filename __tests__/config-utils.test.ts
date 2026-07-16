/**
 * Tests for the gh#79 `isMcpServerConfigured` detect-function.
 *
 * The function reads `~/.claude.json` and reports whether borg is
 * already registered in `mcpServers`. Per gh#79 + dispatch contract:
 *
 *   - File present + `mcpServers.borg` present → true (silent-skip)
 *   - Everything else (file missing, malformed JSON, key absent,
 *     permission denied, empty file, unexpected shape) → false
 *     (caller falls back to prompting)
 *
 * Path is injectable so tests use temp files instead of mocking fs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));
vi.mock('child_process', () => ({ execSync: execSyncMock }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addCodexMcpServer,
  isCodexHookRegistered,
  isCodexMcpServerConfigured,
  isCodexSessionStartHookRegistered,
  isCodexUserPromptSubmitHookRegistered,
  isMcpServerConfigured,
} from '../src/config-utils';
import { resolveRegenPath, resolveLogAuditPath } from '../src/self-path';
import { shellEscape } from '../src/shell-escape';

const CANONICAL_REGEN = shellEscape(resolveRegenPath());
const CANONICAL_AUDIT = shellEscape(resolveLogAuditPath());

let tmpDir: string;
let tmpConfig: string;

beforeEach(() => {
  execSyncMock.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-config-test-'));
  tmpConfig = path.join(tmpDir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isMcpServerConfigured — present cases', () => {
  it('returns true when mcpServers.borg is configured', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({
        mcpServers: {
          borg: { command: 'borg-mcp', args: [], env: {} },
        },
      })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(true);
  });

  it('returns true when borg coexists with other MCP servers', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({
        mcpServers: {
          pal: { command: 'pal', args: [] },
          borg: { command: 'borg-mcp', args: [] },
          another: { command: 'foo' },
        },
      })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(true);
  });

  it('returns true even when the borg entry value is empty/sparse', () => {
    // The detect-function only checks key presence, not entry shape —
    // users may have manually edited the config in unusual but
    // not-corrupt ways.
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({ mcpServers: { borg: {} } })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(true);
  });
});

describe('isMcpServerConfigured — absent / indeterminate cases', () => {
  it('returns false when the config file does not exist', () => {
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when mcpServers section is missing', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({ numStartups: 5, autoUpdates: true })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when mcpServers is present but borg key absent', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({
        mcpServers: { pal: { command: 'pal' } },
      })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false on malformed JSON', () => {
    fs.writeFileSync(tmpConfig, '{ this is not JSON');
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false on empty file', () => {
    fs.writeFileSync(tmpConfig, '');
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false on whitespace-only file', () => {
    fs.writeFileSync(tmpConfig, '   \n\t  \n');
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when top-level JSON is null', () => {
    fs.writeFileSync(tmpConfig, 'null');
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when top-level JSON is an array', () => {
    fs.writeFileSync(tmpConfig, '[]');
    // Function checks `typeof parsed === 'object'` (arrays satisfy this)
    // but `parsed.mcpServers` is undefined on an array — falls through.
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when mcpServers is a string (corrupt shape)', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({ mcpServers: 'not-an-object' })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when mcpServers is an array (corrupt shape; gh#94)', () => {
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({ mcpServers: ['borg'] })
    );
    expect(isMcpServerConfigured(tmpConfig)).toBe(false);
  });

  it('returns false when path points to a directory (read error)', () => {
    // fs.readFileSync on a directory throws EISDIR; the catch should
    // swallow it and return false per the safe-default contract.
    expect(isMcpServerConfigured(tmpDir)).toBe(false);
  });
});

describe('isCodexMcpServerConfigured', () => {
  it('returns true when [mcp_servers.borg] exists with a pinned Codex identity', () => {
    const p = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(p, '[mcp_servers.borg]\ncommand = "borg-mcp"\n\n[mcp_servers.borg.env]\nBORG_AGENT_KIND = "codex"\n');
    expect(isCodexMcpServerConfigured(p)).toBe(true);
  });

  it('continues to recognize the legacy remote-wake identity marker', () => {
    const p = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(p, '[mcp_servers.borg]\ncommand = "borg-mcp"\n\n[mcp_servers.borg.env]\nBORG_CODEX_REMOTE_WAKE = "1"\n');
    expect(isCodexMcpServerConfigured(p)).toBe(true);
  });

  it('returns false when borg MCP exists without remote wake env', () => {
    const p = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(p, '[mcp_servers.borg]\ncommand = "borg-mcp"\n');
    expect(isCodexMcpServerConfigured(p)).toBe(false);
  });

  it('returns false when borg MCP is absent', () => {
    const p = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(p, '[mcp_servers.other]\ncommand = "x"\n');
    expect(isCodexMcpServerConfigured(p)).toBe(false);
  });

  it('writes a durable Codex identity without persisting remote-wake transport', () => {
    const previous = process.env.BORG_CODEX_REMOTE_WAKE;
    process.env.BORG_CODEX_REMOTE_WAKE = '1';
    try {
      addCodexMcpServer();
      const addCall = execSyncMock.mock.calls.find(([command]) =>
        String(command).startsWith('codex mcp add borg ')
      );
      expect(addCall).toBeDefined();
      const [command, options] = addCall! as [string, { env: NodeJS.ProcessEnv }];
      expect(command).toContain('--env BORG_AGENT_KIND=codex');
      expect(command).not.toContain('BORG_CODEX_REMOTE_WAKE');
      expect(options.env.BORG_AGENT_KIND).toBe('codex');
      expect(options.env.BORG_CODEX_REMOTE_WAKE).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BORG_CODEX_REMOTE_WAKE;
      else process.env.BORG_CODEX_REMOTE_WAKE = previous;
    }
  });
});

describe('isCodexHookRegistered', () => {
  it('returns true when a Codex command hook is present', () => {
    const p = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(p, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'borg-regen' }] },
        ],
      },
    }));
    expect(isCodexHookRegistered('SessionStart', 'borg-regen', p)).toBe(true);
  });

  it('returns false on malformed hooks file', () => {
    const p = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(p, '{nope');
    expect(isCodexHookRegistered('SessionStart', 'borg-regen', p)).toBe(false);
  });
});

describe('gh#844 codex hook peeks (gate the writers + the consent disclosure)', () => {
  it('isCodexSessionStartHookRegistered true iff the borg-regen SessionStart hook is present', () => {
    const p = path.join(tmpDir, 'hooks.json');
    // Write bare name — peek should NOT match (requires canonical).
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'borg-regen' }] }] },
    }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
    // Write canonical (shell-escaped) form — peek should match.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: CANONICAL_REGEN }] }] },
    }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(true);
    fs.writeFileSync(p, JSON.stringify({ hooks: {} }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
  });

  it('isCodexUserPromptSubmitHookRegistered true iff the borg-log-audit UPS hook is present', () => {
    const p = path.join(tmpDir, 'hooks.json');
    // Write bare name — peek should NOT match (requires canonical).
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'borg-log-audit' }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(false);
    // Write canonical form — peek should match.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CANONICAL_AUDIT }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(true);
    // SessionStart present but NOT UPS → still false (each hook gated independently).
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: CANONICAL_REGEN }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(false);
  });

  // gh#client#18: raw canonical (unescaped) path must NOT pass strict peek —
  // it needs shell-escaping before it is a valid canonical form.
  it('raw unescaped canonical path does NOT pass strict peek', () => {
    const p = path.join(tmpDir, 'hooks.json');
    // Raw path without shell-escaping (e.g. user hand-edited the config).
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: resolveRegenPath() }] }] },
    }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
    // Raw audit path without shell-escaping.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: resolveLogAuditPath() }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(false);
  });

  // gh#client#18: stale prior-install absolute paths must NOT pass strict
  // canonical peek — they need migration to shell-escaped canonical form.
  it('stale prior-install path does NOT pass strict peek', () => {
    const p = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/old/node_modules/borgmcp/dist/regen.js' }] }] },
    }));
    // Strict peek requires escaped canonical — stale path does NOT pass.
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
    // Stale audit path also does not pass.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/old/.../log-audit.js' }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(false);
  });
});
