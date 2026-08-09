import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
const originalStateRoot = process.env.BORG_STATE_ROOT;

afterEach(() => {
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const STALE_HOOK_PATH = /(?:\.nvm\/versions\/node\/v[^/]+\/|\/dist\/(?:regen|clear-rewake|log-audit|foreign-path-reminder|inbox-monitor)\.js)/;

function assertNoInstallPinnedHookPath(artifacts: readonly string[]): void {
  const offending = artifacts.find((artifact) => STALE_HOOK_PATH.test(artifact));
  if (offending !== undefined) throw new Error(`install-pinned hook command: ${offending}`);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      else if (entry.isFile()) files.push(pathname);
    }
  };
  visit(root);
  return files;
}

describe('written hook config artifacts stay version-stable', () => {
  it('all writers and orientation emit bare bins, with a red self-check', async () => {
    const stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-hook-artifact-')));
    roots.push(stateRoot);
    process.env.BORG_STATE_ROOT = stateRoot;
    vi.resetModules();
    const config = await import('../src/config-utils');
    const { wakePathArming } = await import('../src/regen-format');
    const { installBorgPlugin, openCodePluginPath } = await import('../src/opencode-plugin');
    const project = path.join(stateRoot, '.borg', 'worktrees', 'repo', 'seat');
    fs.mkdirSync(project, { recursive: true });

    config.addSessionStartHook();
    config.addUserPromptSubmitHook();
    config.addProjectSessionStartHook(project);
    config.addClaudeLaunchAccess(project, { worktree: project, scratch: path.join(stateRoot, 'scratch') });
    config.addCodexSessionStartHook();
    config.addCodexUserPromptSubmitHook();
    config.addCodexForeignPathReminderHook();
    installBorgPlugin();

    const artifacts = listFiles(stateRoot).map((file) => fs.readFileSync(file, 'utf8'));
    artifacts.push(wakePathArming('claude', path.join(stateRoot, 'inbox'), path.join(stateRoot, 'monitor')));
    assertNoInstallPinnedHookPath(artifacts);
    expect(artifacts.join('\n')).toContain('borg-regen');
    expect(artifacts.join('\n')).toContain('borg-inbox-monitor');
    expect(fs.readFileSync(openCodePluginPath(), 'utf8')).toContain('borg-regen');

    const seededStale = `${artifacts[0]}\n/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js`;
    expect(() => assertNoInstallPinnedHookPath([seededStale])).toThrow(/install-pinned hook command/);
    const seededPlugin = fs.readFileSync(openCodePluginPath(), 'utf8') +
      '\n/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js';
    expect(() => assertNoInstallPinnedHookPath([seededPlugin])).toThrow(/install-pinned hook command/);
  });
});
