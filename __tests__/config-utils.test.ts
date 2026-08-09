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
  addMcpServer,
  addCodexMcpServer,
  addOpenCodeMcpServer,
  isCodexHookRegistered,
  isCodexMcpServerConfigured,
  isCodexSessionStartHookRegistered,
  isCodexUserPromptSubmitHookRegistered,
  isMcpServerConfigured,
  refreshManagedAgentHookConfigs,
  refreshManagedAgentMcpConfigs,
} from '../src/config-utils';
import { resolveLogAuditPath, resolveRegenPath } from '../src/self-path';

const CANONICAL_REGEN = 'borg-regen';
const CANONICAL_AUDIT = 'borg-log-audit';

let tmpDir: string;
let tmpConfig: string;

beforeEach(() => {
  execSyncMock.mockReset();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-config-test-')));
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

  it('persists the configured state root for Codex MCP children', () => {
    const previous = process.env.BORG_STATE_ROOT;
    const stateRoot = path.join(fs.realpathSync(os.tmpdir()), 'borg state-root');
    process.env.BORG_STATE_ROOT = stateRoot;
    try {
      addCodexMcpServer();
      const addCall = execSyncMock.mock.calls.find(([command]) =>
        String(command).startsWith('codex mcp add borg ')
      );
      expect(addCall).toBeDefined();
      const [command] = addCall! as [string, { env: NodeJS.ProcessEnv }];
      expect(command).toContain(`--env BORG_STATE_ROOT='${stateRoot}'`);
    } finally {
      if (previous === undefined) delete process.env.BORG_STATE_ROOT;
      else process.env.BORG_STATE_ROOT = previous;
    }
  });

  it('persists the configured state root for OpenCode MCP children', () => {
    const previous = process.env.BORG_STATE_ROOT;
    const stateRoot = path.join(fs.realpathSync(os.tmpdir()), 'borg state-root');
    process.env.BORG_STATE_ROOT = stateRoot;
    try {
      addOpenCodeMcpServer();
      const addCall = execSyncMock.mock.calls.find(([command]) =>
        String(command).startsWith('opencode mcp add borg ')
      );
      expect(addCall).toBeDefined();
      const [command] = addCall! as [string, { env: NodeJS.ProcessEnv }];
      expect(command).toContain(`--env BORG_STATE_ROOT='${stateRoot}'`);
    } finally {
      if (previous === undefined) delete process.env.BORG_STATE_ROOT;
      else process.env.BORG_STATE_ROOT = previous;
    }
  });
});

describe('version-stable MCP registrations', () => {
  it('writes a PATH-resolved borg-mcp command for every supported agent CLI', () => {
    addMcpServer();
    addCodexMcpServer();
    addOpenCodeMcpServer();

    const addCommands = execSyncMock.mock.calls
      .map(([command]) => String(command))
      .filter((command) => /^(claude|codex|opencode) mcp add .*\bborg\b/.test(command));

    const assertVersionStable = (commands: string[]) => {
      expect(commands).toHaveLength(3);
      for (const command of commands) {
        expect(command).toMatch(/(?:^| -- | borg )'borg-mcp'$/);
        expect(command).not.toMatch(/\.nvm\/versions\/node\/v[^/]+\//);
        expect(command).not.toContain('/dist/index.js');
      }
    };
    assertVersionStable(addCommands);

    const stale = '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/index.js';
    expect(() => assertVersionStable(
      addCommands.map((command) => command.replace("'borg-mcp'", `'${stale}'`)),
    )).toThrow();
  });

  it('refreshes every stale Borg-written agent registration', () => {
    const claudeConfigPath = path.join(tmpDir, 'claude.json');
    const codexConfigPath = path.join(tmpDir, 'codex.toml');
    const openCodeConfigPath = path.join(tmpDir, 'opencode.json');
    const stale = '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/index.js';
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { borg: { command: stale, args: ['--foreign'], env: { FOREIGN: 'keep' } } },
    }));
    fs.writeFileSync(codexConfigPath,
      `[mcp_servers.borg]\ncommand = "${stale}"\n\n[mcp_servers.borg.env]\nBORG_AGENT_KIND = "codex"\n`,
    );
    fs.writeFileSync(openCodeConfigPath, JSON.stringify({
      mcp: { borg: { type: 'local', command: [stale], environment: { BORG_AGENT_KIND: 'opencode' } } },
    }));
    expect(refreshManagedAgentMcpConfigs({
      claudeConfigPath,
      codexConfigPath,
      openCodeConfigPath,
    })).toEqual(['claude', 'codex', 'opencode']);

    expect(JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')).mcpServers.borg).toEqual({
      command: 'borg-mcp',
      args: ['--foreign'],
      env: { FOREIGN: 'keep' },
    });
    expect(fs.readFileSync(codexConfigPath, 'utf8')).toBe(
      '[mcp_servers.borg]\ncommand = "borg-mcp"\n\n[mcp_servers.borg.env]\nBORG_AGENT_KIND = "codex"\n',
    );
    expect(JSON.parse(fs.readFileSync(openCodeConfigPath, 'utf8')).mcp.borg).toEqual({
      type: 'local',
      command: ['borg-mcp'],
      environment: { BORG_AGENT_KIND: 'opencode' },
    });
  });

  it('does not rewrite registrations that Borg did not write', () => {
    const claudeConfigPath = path.join(tmpDir, 'claude.json');
    const codexConfigPath = path.join(tmpDir, 'codex.toml');
    const openCodeConfigPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { borg: { command: '/opt/operator/custom-server' } },
    }));
    fs.writeFileSync(codexConfigPath,
      '[mcp_servers.borg]\ncommand = "/opt/operator/custom-server"\n\n[mcp_servers.borg.env]\nBORG_AGENT_KIND = "codex"\n',
    );
    fs.writeFileSync(openCodeConfigPath, JSON.stringify({
      mcp: { borg: { type: 'local', command: ['/opt/operator/custom-server'], environment: { BORG_AGENT_KIND: 'opencode' } } },
    }));
    expect(refreshManagedAgentMcpConfigs({
      claudeConfigPath,
      codexConfigPath,
      openCodeConfigPath,
    })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')).mcpServers.borg.command)
      .toBe('/opt/operator/custom-server');
    expect(fs.readFileSync(codexConfigPath, 'utf8')).toContain('command = "/opt/operator/custom-server"');
    expect(JSON.parse(fs.readFileSync(openCodeConfigPath, 'utf8')).mcp.borg.command)
      .toEqual(['/opt/operator/custom-server']);
  });

  it('continues refreshing later agents after one stale config cannot be written', () => {
    const claudeConfigPath = path.join(tmpDir, 'claude.json');
    const codexConfigPath = path.join(tmpDir, 'codex.toml');
    const openCodeConfigPath = path.join(tmpDir, 'opencode.json');
    const stale = '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/index.js';
    fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { borg: { command: stale } } }));
    fs.writeFileSync(codexConfigPath,
      `[mcp_servers.borg]\ncommand = "${stale}"\n\n[mcp_servers.borg.env]\nBORG_AGENT_KIND = "codex"\n`,
    );
    fs.writeFileSync(openCodeConfigPath, JSON.stringify({
      mcp: { borg: { type: 'local', command: [stale], environment: { BORG_AGENT_KIND: 'opencode' } } },
    }));
    expect(() => refreshManagedAgentMcpConfigs({
      claudeConfigPath,
      codexConfigPath,
      openCodeConfigPath,
      refreshClaude: () => { throw new Error('Claude config is read-only'); },
    })).toThrow(/Claude Code.*read-only/);
    expect(fs.readFileSync(codexConfigPath, 'utf8')).toContain('command = "borg-mcp"');
    expect(JSON.parse(fs.readFileSync(openCodeConfigPath, 'utf8')).mcp.borg.command)
      .toEqual(['borg-mcp']);
  });
});

describe('version-stable managed hook refresh', () => {
  it('surgically heals global and canonical worktree hooks without following symlinks', () => {
    const home = path.join(tmpDir, 'home');
    const claudePath = path.join(home, '.claude', 'settings.json');
    const codexPath = path.join(home, '.codex', 'hooks.json');
    const canonical = path.join(home, '.borg', 'worktrees', 'repo', 'seat', '.claude', 'settings.local.json');
    const outside = path.join(tmpDir, 'outside', '.claude', 'settings.local.json');
    const outsideViaClaudeLink = path.join(tmpDir, 'outside-claude', 'settings.local.json');
    const stale = "'/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js'";
    for (const file of [claudePath, codexPath, canonical, outside, outsideViaClaudeLink]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        keep: { operator: true },
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [
            { type: 'command', command: stale, timeout: 30 },
            { type: 'command', command: '/opt/operator/hook' },
          ] }],
          OperatorEvent: [
            { matcher: 'keep-empty', hooks: [] },
            { matcher: 'keep-shape', metadata: { operator: true } },
          ],
        },
      }));
    }
    fs.mkdirSync(path.join(home, '.borg', 'worktrees', 'linked-repo'), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, 'outside'), path.join(home, '.borg', 'worktrees', 'linked-repo', 'linked-seat'));
    const claudeLinkedSeat = path.join(home, '.borg', 'worktrees', 'repo', 'claude-linked-seat');
    fs.mkdirSync(claudeLinkedSeat, { recursive: true });
    fs.symlinkSync(path.dirname(outsideViaClaudeLink), path.join(claudeLinkedSeat, '.claude'));

    expect(refreshManagedAgentHookConfigs({ homeDir: home })).toEqual([
      claudePath,
      codexPath,
      canonical,
    ]);
    for (const file of [claudePath, codexPath, canonical]) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(parsed.keep).toEqual({ operator: true });
      expect(parsed.hooks.SessionStart[0].hooks).toEqual([
        { type: 'command', command: 'borg-regen', timeout: 30 },
        { type: 'command', command: '/opt/operator/hook' },
      ]);
      expect(parsed.hooks.OperatorEvent).toEqual([
        { matcher: 'keep-empty', hooks: [] },
        { matcher: 'keep-shape', metadata: { operator: true } },
      ]);
    }
    expect(fs.readFileSync(outside, 'utf8')).toContain('.nvm/versions/node/v22.22.2');
    expect(fs.readFileSync(outsideViaClaudeLink, 'utf8')).toContain('.nvm/versions/node/v22.22.2');
  });

  it('aggregates invalid managed files after refreshing later files', () => {
    const home = path.join(tmpDir, 'home');
    const claudePath = path.join(home, '.claude', 'settings.json');
    const codexPath = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(claudePath, '{bad json');
    fs.writeFileSync(codexPath, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: "'borg-log-audit'" }] }],
    } }));

    expect(() => refreshManagedAgentHookConfigs({ homeDir: home }))
      .toThrow(/Claude Code.*settings\.json/);
    expect(JSON.parse(fs.readFileSync(codexPath, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe('borg-log-audit');
  });

  it('refuses a symlinked intermediate .borg directory', () => {
    const home = path.join(tmpDir, 'home');
    const externalBorg = path.join(tmpDir, 'external-borg');
    const externalSettings = path.join(externalBorg, 'worktrees', 'repo', 'seat', '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(externalSettings), { recursive: true });
    const stale = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command',
      command: '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js',
    }] }] } });
    fs.writeFileSync(externalSettings, stale);
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(externalBorg, path.join(home, '.borg'));

    expect(refreshManagedAgentHookConfigs({ homeDir: home })).toEqual([]);
    expect(fs.readFileSync(externalSettings, 'utf8')).toBe(stale);
  });

  it('refuses a symlinked worktree settings file', () => {
    const home = path.join(tmpDir, 'home');
    const settingsPath = path.join(
      home,
      '.borg',
      'worktrees',
      'repo',
      'seat',
      '.claude',
      'settings.local.json',
    );
    const externalSettings = path.join(tmpDir, 'external-settings.json');
    const stale = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command',
      command: '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js',
    }] }] } });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(externalSettings, stale);
    fs.symlinkSync(externalSettings, settingsPath);

    expect(refreshManagedAgentHookConfigs({ homeDir: home })).toEqual([]);
    expect(fs.readFileSync(externalSettings, 'utf8')).toBe(stale);
  });
});

describe('native agent registration roots', () => {
  it('preserves native config roots when no Borg override is configured', () => {
    const previous = {
      BORG_STATE_ROOT: process.env.BORG_STATE_ROOT,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.BORG_STATE_ROOT;
    process.env.HOME = path.join(tmpDir, 'native-home');
    process.env.CODEX_HOME = path.join(tmpDir, 'custom-codex');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'custom-xdg');
    try {
      addMcpServer();
      addCodexMcpServer();
      addOpenCodeMcpServer();

      const registrationCalls = execSyncMock.mock.calls.filter(([command]) =>
        /^(claude|codex|opencode) mcp (remove|add)/.test(String(command)),
      );
      expect(registrationCalls).toHaveLength(5);
      for (const [, options] of registrationCalls as Array<[string, { env?: NodeJS.ProcessEnv } | undefined]>) {
        expect(options?.env?.HOME).toBe(process.env.HOME);
        expect(options?.env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
        expect(options?.env?.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('writes Claude, Codex, and OpenCode registrations under the override', () => {
    const previous = {
      BORG_STATE_ROOT: process.env.BORG_STATE_ROOT,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    const stateRoot = path.join(tmpDir, 'state-root');
    const ambientHome = path.join(tmpDir, 'ambient-home');
    process.env.BORG_STATE_ROOT = stateRoot;
    process.env.HOME = ambientHome;
    process.env.CODEX_HOME = path.join(ambientHome, '.codex');
    process.env.XDG_CONFIG_HOME = path.join(ambientHome, '.config');
    execSyncMock.mockImplementation((command: string, options?: { env?: NodeJS.ProcessEnv }) => {
      if (!String(command).includes(' mcp add ')) return;
      const env = options?.env ?? {};
      let target: string | undefined;
      if (String(command).startsWith('claude mcp add')) target = path.join(env.HOME ?? '', '.claude.json');
      if (String(command).startsWith('codex mcp add')) target = path.join(env.CODEX_HOME ?? '', 'config.toml');
      if (String(command).startsWith('opencode mcp add')) target = path.join(env.XDG_CONFIG_HOME ?? '', 'opencode', 'opencode.json');
      if (target) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'registered\n');
      }
    });
    try {
      addMcpServer();
      addCodexMcpServer();
      addOpenCodeMcpServer();

      expect(fs.existsSync(path.join(stateRoot, '.claude.json'))).toBe(true);
      expect(fs.existsSync(path.join(stateRoot, '.codex', 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(stateRoot, '.config', 'opencode', 'opencode.json'))).toBe(true);
      expect(fs.existsSync(path.join(ambientHome, '.claude.json'))).toBe(false);
      expect(fs.existsSync(path.join(ambientHome, '.codex', 'config.toml'))).toBe(false);
      expect(fs.existsSync(path.join(ambientHome, '.config', 'opencode', 'opencode.json'))).toBe(false);

      const registrationCalls = execSyncMock.mock.calls.filter(([command]) =>
        /^(claude|codex|opencode) mcp (remove|add)/.test(String(command)),
      );
      expect(registrationCalls).toHaveLength(5);
      for (const [, options] of registrationCalls as Array<[string, { env?: NodeJS.ProcessEnv } | undefined]>) {
        expect(options?.env?.HOME).toBe(stateRoot);
        expect(options?.env?.CODEX_HOME).toBe(path.join(stateRoot, '.codex'));
        expect(options?.env?.XDG_CONFIG_HOME).toBe(path.join(stateRoot, '.config'));
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
    // The unquoted bare name is the strict canonical form.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'borg-regen' }] }] },
    }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(true);
    // A quoted bare name is owned but needs normalization before strict peek.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'borg-regen'" }] }] },
    }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
    fs.writeFileSync(p, JSON.stringify({ hooks: {} }));
    expect(isCodexSessionStartHookRegistered(p)).toBe(false);
  });

  it('isCodexUserPromptSubmitHookRegistered true iff the borg-log-audit UPS hook is present', () => {
    const p = path.join(tmpDir, 'hooks.json');
    // The unquoted bare name is the strict canonical form.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'borg-log-audit' }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(true);
    // A quoted bare name is owned but needs normalization before strict peek.
    fs.writeFileSync(p, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: "'borg-log-audit'" }] }] },
    }));
    expect(isCodexUserPromptSubmitHookRegistered(p)).toBe(false);
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

  // Stale prior-install absolute paths must not pass strict canonical peek;
  // they need migration to the stable bare command.
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
