import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectAgentIntegrationHealth,
  renderAgentIntegrationHealth,
  renderOpenCodeStartupDiagnostics,
  runDoctor,
  warnIfAgentIntegrationUnhealthy,
} from '../src/agent-integration-health';
import { buildBorgPluginSource } from '../src/opencode-plugin';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageFixture(version = '3.3.0') {
  const root = fs.realpathSync(mkdtempSync(join(tmpdir(), 'borg-hook-health-')));
  roots.push(root);
  const packageRoot = join(root, 'lib', 'node_modules', 'borgmcp');
  const dist = join(packageRoot, 'dist');
  const bin = join(root, 'bin');
  mkdirSync(dist, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'borgmcp', version }));
  const names = ['borg-regen', 'borg-clear-rewake', 'borg-log-audit', 'borg-foreign-path-reminder', 'borg-inbox-monitor'];
  for (const name of names) {
    const target = join(dist, `${name.replace(/^borg-/, '')}.js`);
    writeFileSync(target, '#!/usr/bin/env node\n');
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, name));
  }
  return { root, bin, names };
}

function configureOpenCode(home: string): void {
  const config = join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(config, JSON.stringify({ mcp: { borg: { type: 'local' } } }));
}

describe('agent integration health', () => {
  it('accepts only bins owned by the running borgmcp version and inventories the OpenCode plugin', () => {
    const f = packageFixture();
    const plugin = join(f.root, 'home', '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, buildBorgPluginSource('3.3.0'));
    configureOpenCode(join(f.root, 'home'));
    const report = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0',
      path: f.bin,
      homeDir: join(f.root, 'home'),
    });
    expect(report.issues).toEqual([]);
    expect(report.bins.map((bin) => [bin.name, bin.status])).toEqual(
      f.names.map((name) => [name, 'ok']),
    );
    expect(report.openCodePlugin).toMatchObject({ path: plugin, status: 'ok', version: '3.3.0' });
    expect(renderAgentIntegrationHealth(report)).toContain(
      'OpenCode borg-orient.js plugin: ok (3.3.0)',
    );
  });

  it('renders an absent plugin as non-actionable inventory when OpenCode is not configured', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    expect(report.openCodePlugin).toMatchObject({ configured: false, status: 'absent' });
    expect(report.issues).toEqual([]);
    expect(renderAgentIntegrationHealth(report)).toContain('OpenCode borg-orient.js plugin: absent');
    expect(renderAgentIntegrationHealth(report)).not.toContain('Repair missing OpenCode plugin');
  });

  it.each(['3.3.0', '3.2.0'])(
    'renders a readable %s plugin as present inventory when OpenCode is not configured',
    (version) => {
      const f = packageFixture();
      const home = join(f.root, 'home');
      const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
      mkdirSync(join(plugin, '..'), { recursive: true });
      writeFileSync(plugin, buildBorgPluginSource(version));
      const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
      expect(report.openCodePlugin).toMatchObject({ configured: false, status: 'present' });
      expect(report.issues).toEqual([]);
      const text = renderAgentIntegrationHealth(report);
      expect(text).toContain('OpenCode borg-orient.js plugin: present');
      expect(text).not.toContain('expected 3.3.0');
      expect(text).not.toContain('Repair OpenCode plugin');
    },
  );

  it('makes an outdated OpenCode plugin actionable with relaunch recovery', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, buildBorgPluginSource('3.2.0'));
    configureOpenCode(home);
    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    expect(report.openCodePlugin).toMatchObject({ status: 'outdated', version: '3.2.0' });
    expect(report.issues).toContain(report.openCodePlugin);
    expect(renderAgentIntegrationHealth(report)).toContain(
      `OpenCode borg-orient.js plugin: version 3.2.0, expected 3.3.0 at ${plugin}`,
    );
    expect(renderAgentIntegrationHealth(report)).toContain(
      'Repair OpenCode plugin: borg update --yes',
    );
  });

  it('renders the real unmarked 3.3.0 plugin as version unknown', () => {
    const f = packageFixture('3.4.0');
    const home = join(f.root, 'home');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    const legacySource = readFileSync(
      new URL('./fixtures/opencode-plugin-3.3.0.js', import.meta.url),
      'utf8',
    );
    expect(Buffer.byteLength(legacySource)).toBe(386);
    expect(createHash('sha256').update(legacySource).digest('hex')).toBe(
      '14a64bb955245b818e8afc46a429791868b6ad87d72996d2775b04411095295c',
    );
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, legacySource);
    configureOpenCode(home);

    const report = inspectAgentIntegrationHealth({
      expectedVersion: '3.4.0',
      path: f.bin,
      homeDir: home,
    });
    expect(report.openCodePlugin).toMatchObject({
      configured: true,
      status: 'outdated',
      version: 'unknown',
    });
    expect(report.issues).toContain(report.openCodePlugin);

    report.openCodePlugin.path = '/Users/example/.config/opencode/plugins/borg-orient.js';
    const status = renderAgentIntegrationHealth(report).split('\n').find(
      (line) => line.startsWith('OpenCode borg-orient.js plugin:'),
    );
    expect(status).toBe(
      'OpenCode borg-orient.js plugin: version unknown, expected 3.4.0 at /Users/example/.config/opencode/plugins/borg-orient.js',
    );
    expect(Buffer.byteLength(status!)).toBe(121);
    expect(createHash('sha256').update(status!).digest('hex')).toBe(
      'f73b36639d3d3769e05155c59a5fbb3b41bc537c631f15d970bfa5ef525bcf6f',
    );
    expect(renderAgentIntegrationHealth(report)).toContain(
      'Repair OpenCode plugin: borg update --yes',
    );
  });

  it('makes a missing OpenCode plugin actionable', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    configureOpenCode(home);
    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    expect(report.openCodePlugin.status).toBe('missing');
    expect(report.issues).toContain(report.openCodePlugin);
    expect(renderAgentIntegrationHealth(report)).toContain(
      `OpenCode borg-orient.js plugin: missing at ${join(home, '.config', 'opencode', 'plugins', 'borg-orient.js')}`,
    );
    expect(renderAgentIntegrationHealth(report)).toContain(
      'Repair missing OpenCode plugin: borg update --yes',
    );
  });

  it('inventories a refused unconfigured OpenCode plugin without recovery', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(plugin, { recursive: true });
    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    const text = renderAgentIntegrationHealth(report);
    expect(report.openCodePlugin).toMatchObject({
      configured: false,
      status: 'refused',
      detail: 'plugin path is not a regular file',
    });
    expect(report.issues).toEqual([]);
    expect(text).toContain(`OpenCode borg-orient.js plugin: refused at ${plugin}`);
    expect(text).not.toContain('Remove or replace the OpenCode plugin path');
  });

  it('gives a refused configured OpenCode plugin the two-step update recovery', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(plugin, { recursive: true });
    configureOpenCode(home);
    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    const text = renderAgentIntegrationHealth(report);
    expect(report.openCodePlugin).toMatchObject({
      configured: true,
      status: 'refused',
      detail: 'plugin path is not a regular file',
    });
    expect(report.issues).toContain(report.openCodePlugin);
    expect(text).toContain(`OpenCode borg-orient.js plugin: refused at ${plugin}`);
    expect(text).toContain(
      `Remove or replace the OpenCode plugin path ${plugin}, then run: borg update --yes`,
    );
  });

  it('renders a symlinked plugin as refused inventory or a configured issue', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    const target = join(home, 'operator-data.txt');
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(target, 'operator data');
    symlinkSync(target, plugin);

    const inventory = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0', path: f.bin, homeDir: home,
    });
    expect(inventory.openCodePlugin).toMatchObject({
      configured: false,
      status: 'refused',
      detail: 'plugin path is a symlink',
    });
    expect(inventory.issues).toEqual([]);
    expect(renderAgentIntegrationHealth(inventory)).not.toContain(
      'Remove or replace the OpenCode plugin path',
    );

    configureOpenCode(home);
    const actionable = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0', path: f.bin, homeDir: home,
    });
    expect(actionable.openCodePlugin).toMatchObject({ configured: true, status: 'refused' });
    expect(actionable.issues).toContain(actionable.openCodePlugin);
    actionable.openCodePlugin.path = '/Users/example/.config/opencode/plugins/borg-orient.js';
    const text = renderAgentIntegrationHealth(actionable);
    const status = text.split('\n').find((line) => line.startsWith('OpenCode borg-orient.js plugin:'));
    const recovery = text.split('\n').find(
      (line) => line.startsWith('Remove or replace the OpenCode plugin path'),
    );
    expect(status).toBe(
      'OpenCode borg-orient.js plugin: refused at /Users/example/.config/opencode/plugins/borg-orient.js (plugin path is a symlink)',
    );
    expect(recovery).toBe(
      'Remove or replace the OpenCode plugin path /Users/example/.config/opencode/plugins/borg-orient.js, then run: borg update --yes',
    );
  });

  it('names missing, wrong-owner, and version-skew bins with truthful status-specific recovery', () => {
    const f = packageFixture('3.2.0');
    rmSync(join(f.bin, 'borg-clear-rewake'));
    const foreignRoot = join(f.root, 'foreign');
    mkdirSync(foreignRoot, { recursive: true });
    writeFileSync(join(foreignRoot, 'package.json'), JSON.stringify({ name: 'other-package', version: '3.3.0' }));
    const foreignBin = join(foreignRoot, 'foreign-path-reminder.js');
    writeFileSync(foreignBin, '');
    chmodSync(foreignBin, 0o755);
    rmSync(join(f.bin, 'borg-foreign-path-reminder'));
    symlinkSync(foreignBin, join(f.bin, 'borg-foreign-path-reminder'));

    const report = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
    });
    const text = renderAgentIntegrationHealth(report);
    expect(text).toContain('borg-clear-rewake: missing');
    expect(text).toContain(
      `borg-foreign-path-reminder: wrong owner other-package@3.3.0 at ${fs.realpathSync(foreignBin)}`,
    );
    expect(text).toContain(
      `borg-regen: version 3.2.0, expected 3.3.0 at ${fs.realpathSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'dist', 'regen.js'))}`,
    );
    expect(text).toContain('npm install --global borgmcp@3.3.0 --ignore-scripts');
    expect(text).toContain('Fix PATH so borg-foreign-path-reminder resolves to borgmcp@3.3.0');
    expect(text).toContain('Fix PATH so borg-regen resolves to borgmcp@3.3.0');
    expect(text).toContain('then run: borg doctor');
    expect(text).not.toContain('borg doctor.');
    expect(text).not.toContain('Repair: borg update --yes');
  });

  it('runs doctor read-only and exits nonzero for actionable findings', () => {
    const f = packageFixture();
    rmSync(join(f.bin, 'borg-inbox-monitor'));
    const before = readFileSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'package.json'), 'utf8');
    const stdout: string[] = [];
    expect(runDoctor({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
      openCodeStartupLogPath: join(f.root, 'absent-startup.log'),
      stdout: (text) => stdout.push(text),
    })).toBe(1);
    expect(stdout.join('')).toContain('borg-inbox-monitor: missing');
    expect(readFileSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'package.json'), 'utf8')).toBe(before);
  });

  it('surfaces the bounded OpenCode startup diagnostic without changing doctor health', () => {
    const f = packageFixture();
    const diagnosticPath = join(f.root, 'borg-opencode-drone-startup.log');
    writeFileSync(diagnosticPath, '[timestamp] identity handshake failed\n', { mode: 0o600 });
    const stdout: string[] = [];

    expect(runDoctor({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
      openCodeStartupLogPath: diagnosticPath,
      stdout: (text) => stdout.push(text),
    })).toBe(0);
    expect(stdout.join('')).toContain(`OpenCode startup diagnostics (${diagnosticPath}):`);
    expect(stdout.join('')).toContain('identity handshake failed');
  });

  it('refuses to follow a startup diagnostic symlink', () => {
    const f = packageFixture();
    const target = join(f.root, 'target.log');
    const diagnosticPath = join(f.root, 'borg-opencode-drone-startup.log');
    writeFileSync(target, 'not a Borg diagnostic');
    symlinkSync(target, diagnosticPath);

    expect(renderOpenCodeStartupDiagnostics(diagnosticPath)).toBe(
      `OpenCode startup diagnostics: refused at ${diagnosticPath} (path is not a regular file)\n`,
    );
  });

  it('reports stale managed hook commands without changing the config', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const configPath = join(home, '.claude', 'settings.json');
    const plugin = join(home, '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, buildBorgPluginSource('3.3.0'));
    const stale = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command',
      command: '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js',
    }] }] } });
    writeFileSync(configPath, stale);

    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    expect(renderAgentIntegrationHealth(report)).toContain(`stale: ${configPath}`);
    expect(renderAgentIntegrationHealth(report)).toContain('Repair stale managed hooks: borg update --yes');
    expect(report.issues).toHaveLength(1);
    expect(readFileSync(configPath, 'utf8')).toBe(stale);
  });

  it('names an invalid hook file that must be repaired before update can rewrite it', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const configPath = join(home, '.codex', 'hooks.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, '{not json');

    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    const text = renderAgentIntegrationHealth(report);
    expect(text).toContain(`invalid: ${configPath}`);
    expect(text).toContain(`Repair invalid managed hook config ${configPath}, then run: borg update --yes`);
  });

  it('launch-time visibility warns and continues with truthful recovery', () => {
    const f = packageFixture('3.2.0');
    const stderr: string[] = [];
    expect(warnIfAgentIntegrationUnhealthy({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
      stderr: (text) => stderr.push(text),
    })).toBe(false);
    expect(stderr.join('')).toContain(
      `borg-regen: version 3.2.0, expected 3.3.0 at ${fs.realpathSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'dist', 'regen.js'))}`,
    );
    expect(stderr.join('')).toContain('Fix PATH so borg-regen resolves to borgmcp@3.3.0');
    expect(stderr.join('')).toContain('then run: borg doctor');
    expect(stderr.join('')).not.toContain('borg doctor.');
  });

  it('names the unreadable resolved path and ends recovery with a copyable command', () => {
    const f = packageFixture();
    const unreadablePath = join(f.root, 'missing', 'borg-inbox-monitor');
    const report = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0',
      path: f.bin,
      homeDir: join(f.root, 'home'),
      resolveBin: (name) => name === 'borg-inbox-monitor'
        ? unreadablePath
        : join(f.bin, name),
    });
    const text = renderAgentIntegrationHealth(report);
    expect(text).toContain(`borg-inbox-monitor: unreadable at ${unreadablePath}`);
    expect(text).toContain('Fix or replace unreadable borg-inbox-monitor, then run: borg doctor');
    expect(text).not.toContain('borg doctor.');
  });

  it('contains inventory read errors and warns instead of throwing from launch health', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const globalConfig = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(globalConfig, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command',
      command: '/old/node_modules/borgmcp/dist/regen.js',
    }] }] } }));
    mkdirSync(join(home, '.borg', 'worktrees'), { recursive: true });
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((pathname: fs.PathLike, options?: unknown) => {
      if (String(pathname).endsWith('/.borg/worktrees')) throw new Error('inventory denied');
      return original(pathname, options as never);
    }) as typeof fs.readdirSync);
    const stderr: string[] = [];
    try {
      expect(warnIfAgentIntegrationUnhealthy({
        expectedVersion: '3.3.0', path: f.bin, homeDir: home,
        stderr: (text) => stderr.push(text),
      })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(stderr.join('')).toContain('inventory denied');
    expect(stderr.join('')).toContain(`stale: ${globalConfig}`);
    expect(stderr.join('')).toContain(
      `Restore readable, non-symlinked hook inventory path ${join(home, '.borg', 'worktrees')}, then run: borg doctor`,
    );
    expect(stderr.join('')).not.toContain('borg doctor.');
    expect(stderr.join('')).toMatch(/warning/i);
  });
});
