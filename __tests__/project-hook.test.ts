/**
 * gh#673 P2 (WI-1): project-local SessionStart hook install.
 *
 * The borg-regen orientation hook moves from the GLOBAL
 * ~/.claude/settings.json to the assimilated repo's
 * <root>/.claude/settings.local.json (V1-probed: Claude Code merges +
 * fires hooks from settings.local.json; the .local variant is
 * user-authored/uncommitted so no collaborator imposition or
 * trust-prompt concern). Installed by `borg assimilate` (incl. into a
 * freshly spawned sibling worktree) and ensured on every bare `borg`
 * launch, which then cleans up the legacy global entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addProjectSessionStartHook,
  isProjectSessionStartHookRegistered,
} from '../src/config-utils';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-project-hook-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(root, '.claude', 'settings.local.json');
}

describe('addProjectSessionStartHook', () => {
  it('creates separate orientation and clear-only async-rewake SessionStart hooks', () => {
    expect(addProjectSessionStartHook(root)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
    const entries = parsed.hooks.SessionStart;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toContainEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: 'borg-regen' }],
    });
    expect(entries).toContainEqual({
      matcher: 'clear',
      hooks: [{ type: 'command', command: 'borg-clear-rewake', asyncRewake: true }],
    });
  });

  it('is idempotent — a second call changes nothing', () => {
    expect(addProjectSessionStartHook(root)).toBe(true);
    const first = fs.readFileSync(settingsPath(), 'utf-8');
    expect(addProjectSessionStartHook(root)).toBe(false);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(first);
  });

  it('preserves unrelated existing settings.local.json content', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool' }] }] },
      })
    );
    expect(addProjectSessionStartHook(root)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
    expect(parsed.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('other-tool');
    expect(parsed.hooks.SessionStart).toBeDefined();
  });

  it('repairs a partial install without duplicating the existing orientation hook', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'borg-regen' }] }] },
    }));

    expect(addProjectSessionStartHook(root)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).hooks.SessionStart;
    expect(entries.filter((e: any) => e.hooks?.some((h: any) => h.command === 'borg-regen'))).toHaveLength(1);
    expect(entries.filter((e: any) => e.hooks?.some((h: any) => h.command === 'borg-clear-rewake'))).toHaveLength(1);
  });

  it('repairs a partial install without duplicating the existing clear-rewake hook', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{
        matcher: 'clear',
        hooks: [{ type: 'command', command: 'borg-clear-rewake', asyncRewake: true }],
      }] },
    }));

    expect(addProjectSessionStartHook(root)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).hooks.SessionStart;
    expect(entries.filter((e: any) => e.hooks?.some((h: any) => h.command === 'borg-regen'))).toHaveLength(1);
    expect(entries.filter((e: any) => e.hooks?.some((h: any) => h.command === 'borg-clear-rewake'))).toHaveLength(1);
  });

  it.each([
    ['wrong matcher', { matcher: '*', hooks: [{ type: 'command', command: 'borg-clear-rewake', asyncRewake: true }] }],
    ['missing asyncRewake', { matcher: 'clear', hooks: [{ type: 'command', command: 'borg-clear-rewake' }] }],
    ['false asyncRewake', { matcher: 'clear', hooks: [{ type: 'command', command: 'borg-clear-rewake', asyncRewake: false }] }],
  ])('repairs %s and leaves exactly one canonical clear handler', (_label, malformed) => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [
        { matcher: '*', hooks: [{ type: 'command', command: 'borg-regen' }] },
        { ...malformed, hooks: [...malformed.hooks, { type: 'command', command: 'other-tool' }] },
      ] },
    }));

    expect(isProjectSessionStartHookRegistered(root)).toBe(false);
    expect(addProjectSessionStartHook(root)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).hooks.SessionStart;
    const clearEntries = entries.filter((entry: any) =>
      entry.hooks?.some((hook: any) => hook.command === 'borg-clear-rewake')
    );
    expect(clearEntries).toEqual([{
      matcher: 'clear',
      hooks: [{ type: 'command', command: 'borg-clear-rewake', asyncRewake: true }],
    }]);
    expect(entries.some((entry: any) => entry.hooks?.some((hook: any) => hook.command === 'other-tool'))).toBe(true);
    expect(addProjectSessionStartHook(root)).toBe(false);
  });

  it('routes clear to both independent handlers and other sources only to orientation', () => {
    addProjectSessionStartHook(root);
    const entries = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')).hooks.SessionStart;
    const commandsFor = (source: string) => entries
      .filter((entry: any) => entry.matcher === '*' || entry.matcher === source)
      .flatMap((entry: any) => entry.hooks.map((hook: any) => hook.command));

    expect(commandsFor('clear')).toEqual(['borg-regen', 'borg-clear-rewake']);
    expect(commandsFor('startup')).toEqual(['borg-regen']);
    expect(commandsFor('resume')).toEqual(['borg-regen']);
    expect(commandsFor('compact')).toEqual(['borg-regen']);
  });

  it('returns false (no write) on unparseable existing settings instead of clobbering', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');
    expect(addProjectSessionStartHook(root)).toBe(false);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe('{ not json');
  });
});

describe('isProjectSessionStartHookRegistered', () => {
  it('false before install, true after', () => {
    expect(isProjectSessionStartHookRegistered(root)).toBe(false);
    addProjectSessionStartHook(root);
    expect(isProjectSessionStartHookRegistered(root)).toBe(true);
  });

  it('requires both project-local handlers', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'borg-regen' }] }] },
    }));
    expect(isProjectSessionStartHookRegistered(root)).toBe(false);
  });
});
