import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  addClaudeLaunchAccess,
  addCodexForeignPathReminderHook,
  addOpenCodeLaunchAccess,
  isCodexHookRegistered,
} from '../src/config-utils';
import { codexLaunchDirectoryArgs, scratchRootForSeat } from '../src/launch-access';
import { codexLaunchDirectoryArgs as builtCodexLaunchDirectoryArgs } from '../dist/launch-access.js';

let root: string;
let paths: { worktree: string; scratch: string; commonDir: string };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-launch-access-')));
  paths = {
    worktree: path.join(root, 'worktree'),
    scratch: path.join(root, 'scratch', 'drone-1'),
    commonDir: path.join(root, 'worktree', '.git'),
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('per-seat launch paths', () => {
  it('uses the seat label and omits an ordinary checkout common directory nested under the worktree', () => {
    expect(scratchRootForSeat('/home/test', 'drone-1', 'drone-id')).toBe(
      '/home/test/.borg/scratch/drone-1',
    );
    expect(codexLaunchDirectoryArgs(paths)).toEqual([
      '--add-dir', paths.worktree,
      '--add-dir', paths.scratch,
    ]);
  });

  it('adds a linked worktree common directory as one argv-safe Codex grant', () => {
    const linkedPaths = {
      ...paths,
      worktree: path.join(root, 'worktree with spaces'),
      commonDir: path.join(root, 'origin checkout', '.git'),
    };

    expect(codexLaunchDirectoryArgs(linkedPaths)).toEqual([
      '--add-dir', linkedPaths.worktree,
      '--add-dir', linkedPaths.scratch,
      '--add-dir', linkedPaths.commonDir,
    ]);
  });

  it('canonicalizes and deduplicates Codex launch grants', () => {
    expect(codexLaunchDirectoryArgs({
      worktree: path.join(root, 'repo', '..', 'repo'),
      scratch: path.join(root, 'repo'),
      commonDir: path.join(root, 'origin', '.git'),
    })).toEqual([
      '--add-dir', path.join(root, 'repo'),
      '--add-dir', path.join(root, 'origin', '.git'),
    ]);
  });

  it('ships the linked-worktree common directory behavior in the built artifact', () => {
    const linkedPaths = {
      ...paths,
      commonDir: path.join(root, 'origin', '.git'),
    };

    expect(builtCodexLaunchDirectoryArgs(linkedPaths)).toEqual(
      codexLaunchDirectoryArgs(linkedPaths),
    );
    expect(builtCodexLaunchDirectoryArgs(linkedPaths)).toContain(linkedPaths.commonDir);
  });
});

describe('Claude launch access', () => {
  it('adds exactly the seat worktree and scratch root plus a PreToolUse reminder', () => {
    const settingsPath = path.join(root, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool' }] }] },
    }));

    expect(addClaudeLaunchAccess(root, paths)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(parsed.permissions.additionalDirectories).toEqual([paths.worktree, paths.scratch]);
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(parsed.hooks.PreToolUse).toContainEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: 'borg-foreign-path-reminder' }],
    });

    const first = fs.readFileSync(settingsPath, 'utf8');
    expect(addClaudeLaunchAccess(root, paths)).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(first);
  });

  it('does not broaden a pre-existing additional directory', () => {
    const settingsPath = path.join(root, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { additionalDirectories: ['/already-approved'] },
    }));

    addClaudeLaunchAccess(root, paths);
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(parsed.permissions.additionalDirectories).toEqual([
      '/already-approved',
      paths.worktree,
      paths.scratch,
    ]);
  });
});

describe('OpenCode launch access', () => {
  it('writes subtree rules to the seat-local config and preserves global-style settings', () => {
    const configPath = path.join(root, '.opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      theme: 'dark',
      permission: { bash: 'ask', external_directory: { '*': 'ask', '/already-approved': 'allow' } },
    }));

    expect(addOpenCodeLaunchAccess(root, paths)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.permission.bash).toBe('ask');
    expect(parsed.permission.external_directory).toEqual({
      '*': 'ask',
      '/already-approved': 'allow',
      [`${paths.worktree}/**`]: 'allow',
      [`${paths.scratch}/**`]: 'allow',
    });
    expect(fs.existsSync(path.join(root, '.config', 'opencode', 'opencode.json'))).toBe(false);

    const first = fs.readFileSync(configPath, 'utf8');
    expect(addOpenCodeLaunchAccess(root, paths)).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
  });

  it('migrates predecessor literal allows without replacing user subtree decisions', () => {
    const configPath = path.join(root, '.opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      permission: {
        external_directory: {
          [paths.worktree]: 'allow',
          [`${paths.worktree}/**`]: 'deny',
          [`${paths.scratch}/**`]: 'deny',
        },
      },
    }));

    expect(addOpenCodeLaunchAccess(root, paths)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsed.permission.external_directory).toEqual({
      [`${paths.worktree}/**`]: 'deny',
      [`${paths.scratch}/**`]: 'deny',
    });
  });

  it('leaves a user-authored exact deny untouched during migration', () => {
    const configPath = path.join(root, '.opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      permission: {
        external_directory: {
          [paths.worktree]: 'allow',
          [paths.scratch]: 'deny',
        },
      },
    }));

    expect(addOpenCodeLaunchAccess(root, paths)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsed.permission.external_directory).toEqual({
      [`${paths.worktree}/**`]: 'allow',
      [paths.scratch]: 'deny',
    });
  });
});

describe('Codex launch hook', () => {
  it('adds a native PreToolUse hook without touching other events or config.toml', () => {
    const codexHome = path.join(root, '.codex');
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing' }] }] },
    }));

    expect(addCodexForeignPathReminderHook(hooksPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('existing');
    expect(parsed.hooks.PreToolUse).toContainEqual({
      hooks: [{ type: 'command', command: 'borg-foreign-path-reminder' }],
    });
    expect(isCodexHookRegistered('PreToolUse', 'borg-foreign-path-reminder', hooksPath)).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });
});

describe('foreign-path reminder executable', () => {
  function runHook(payload: unknown, cli: 'claude' | 'codex' = 'claude'): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/foreign-path-reminder.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BORG_LAUNCH_WORKTREE: paths.worktree,
        BORG_LAUNCH_SCRATCH: paths.scratch,
        BORG_LAUNCH_CLI: cli,
      },
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
  }

  it('delivers a Claude reminder through the supported hook output shape', () => {
    const result = runHook({ cwd: paths.worktree, tool_input: { file_path: '/other/checkout/file.ts' } });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      systemMessage?: string;
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(output.systemMessage).toContain('Reminder: this drone is scoped');
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      additionalContext: output.systemMessage,
    });
  });

  it('delivers a Codex reminder through its supported PreToolUse output shape', () => {
    const result = runHook({ cwd: paths.worktree, tool_input: { file_path: '/other/checkout/file.ts' } }, 'codex');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: 'Reminder: this drone is scoped to its own worktree and scratch root; coordinate before working on a foreign path.',
    });
  });

  it('is silent for worktree and scratch targets', () => {
    const result = runHook({
      cwd: paths.worktree,
      tool_input: { file_path: `${paths.worktree}/src/index.ts`, command: `touch ${paths.scratch}/probe` },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('reminds when the tool working directory itself is foreign', () => {
    const result = runHook({ cwd: '/other/checkout', tool_input: { command: 'pwd' } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('Reminder: this drone is scoped');
  });
});
