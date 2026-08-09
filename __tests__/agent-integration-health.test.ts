import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectAgentIntegrationHealth,
  renderAgentIntegrationHealth,
  runDoctor,
  warnIfAgentIntegrationUnhealthy,
} from '../src/agent-integration-health';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageFixture(version = '3.3.0') {
  const root = mkdtempSync(join(tmpdir(), 'borg-hook-health-'));
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

describe('agent integration health', () => {
  it('accepts only bins owned by the running borgmcp version and inventories the OpenCode plugin', () => {
    const f = packageFixture();
    const plugin = join(f.root, 'home', '.config', 'opencode', 'plugins', 'borg-orient.js');
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, 'plugin');
    const report = inspectAgentIntegrationHealth({
      expectedVersion: '3.3.0',
      path: f.bin,
      homeDir: join(f.root, 'home'),
    });
    expect(report.issues).toEqual([]);
    expect(report.bins.map((bin) => [bin.name, bin.status])).toEqual(
      f.names.map((name) => [name, 'ok']),
    );
    expect(report.openCodePlugin).toEqual({ path: plugin, present: true });
  });

  it('names missing, wrong-owner, and version-skew bins with the exact repair', () => {
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
    expect(text).toContain('borg-foreign-path-reminder: wrong owner other-package@3.3.0');
    expect(text).toContain('borg-regen: version 3.2.0, expected 3.3.0');
    expect(text).toContain('Repair: borg update --yes');
  });

  it('runs doctor read-only and exits nonzero for actionable findings', () => {
    const f = packageFixture();
    rmSync(join(f.bin, 'borg-inbox-monitor'));
    const before = readFileSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'package.json'), 'utf8');
    const stdout: string[] = [];
    expect(runDoctor({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
      stdout: (text) => stdout.push(text),
    })).toBe(1);
    expect(stdout.join('')).toContain('borg-inbox-monitor: missing');
    expect(readFileSync(join(f.root, 'lib', 'node_modules', 'borgmcp', 'package.json'), 'utf8')).toBe(before);
  });

  it('reports stale managed hook commands without changing the config', () => {
    const f = packageFixture();
    const home = join(f.root, 'home');
    const configPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const stale = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command',
      command: '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/borgmcp/dist/regen.js',
    }] }] } });
    writeFileSync(configPath, stale);

    const report = inspectAgentIntegrationHealth({ expectedVersion: '3.3.0', path: f.bin, homeDir: home });
    expect(renderAgentIntegrationHealth(report)).toContain(`stale: ${configPath}`);
    expect(report.issues).toHaveLength(1);
    expect(readFileSync(configPath, 'utf8')).toBe(stale);
  });

  it('launch-time visibility warns and continues with the exact repair command', () => {
    const f = packageFixture('3.2.0');
    const stderr: string[] = [];
    expect(warnIfAgentIntegrationUnhealthy({
      expectedVersion: '3.3.0', path: f.bin, homeDir: join(f.root, 'home'),
      stderr: (text) => stderr.push(text),
    })).toBe(false);
    expect(stderr.join('')).toContain('borg-regen: version 3.2.0, expected 3.3.0');
    expect(stderr.join('')).toContain('Repair: borg update --yes');
  });
});
