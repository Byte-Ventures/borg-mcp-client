import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchOpenCodeProcess } from '../src/claude';
import {
  BORG_LAUNCH_EXPECTED_SEAT_ENV,
  withLaunchSeatExpectationEnv,
} from '../src/cubes';
import { ensureCliMcpConfigured } from '../src/ensure-mcp-config';
import { createOpenCodeLaunchKickoff } from '../src/opencode-drone';

const originalPath = process.env.PATH;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const originalExpectedSeat = process.env.BORG_LAUNCH_EXPECTED_SEAT;
const roots: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  if (originalExpectedSeat === undefined) delete process.env.BORG_LAUNCH_EXPECTED_SEAT;
  else process.env.BORG_LAUNCH_EXPECTED_SEAT = originalExpectedSeat;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`);
  fs.chmodSync(file, 0o755);
}

describe('OpenCode launch-seat MCP handoff', () => {
  it('delivers the launch marker through registered config to the actual MCP child boundary', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-opencode-seat-')));
    roots.push(root);
    const bin = path.join(root, 'bin');
    const capture = path.join(root, 'mcp-child-marker');
    fs.mkdirSync(bin);

    writeExecutable(path.join(bin, 'opencode'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const configPath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
if (args[0] === 'mcp' && args[1] === 'add') {
  const environment = {};
  for (let i = 3; i < args.length; i++) {
    if (args[i] !== '--env') continue;
    const value = args[++i];
    const separator = value.indexOf('=');
    environment[value.slice(0, separator)] = value.slice(separator + 1);
  }
  const commandSeparator = args.indexOf('--');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    mcp: { borg: { type: 'local', command: args.slice(commandSeparator + 1), environment } },
  }));
  process.exit(0);
}
const server = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcp.borg;
const environment = Object.fromEntries(Object.entries(server.environment).map(([key, value]) => [
  key,
  value.replace(/\{env:([^}]+)\}/g, (_match, name) => process.env[name] ?? ''),
]));
const child = spawnSync(server.command[0], server.command.slice(1), {
  env: { ...process.env, ...environment },
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
`);
    writeExecutable(path.join(bin, 'borg-mcp'), String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.env.BORG_TEST_CAPTURE, process.env.BORG_LAUNCH_EXPECTED_SEAT ?? '<missing>');
`);

    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
    process.env.BORG_STATE_ROOT = root;
    const expectation = {
      credentialRef: `borg-server-session:${'a'.repeat(64)}`,
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      worktree: '/work/a',
      droneLabel: 'builder-aaaaaaaa',
    };
    process.env.BORG_LAUNCH_EXPECTED_SEAT = JSON.stringify(expectation);
    const configPath = path.join(root, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { borg: { type: 'local', command: ['borg-mcp'], environment: { BORG_SESSION: '1' } } },
    }));
    expect(ensureCliMcpConfigured('opencode')).toBe(true);

    const kickoff = createOpenCodeLaunchKickoff('kickoff');
    const launched = launchOpenCodeProcess({
      cwd: root,
      port: 15555,
      prompt: kickoff.prompt,
      passthroughArgs: [],
      env: withLaunchSeatExpectationEnv({
        ...process.env,
        BORG_TEST_CAPTURE: capture,
        XDG_CONFIG_HOME: path.join(root, '.config'),
      }, expectation),
      droneLabel: expectation.droneLabel,
      cubeName: 'alpha',
      kickoff,
      connect: async () => {},
    });
    const [exitCode] = await once(launched.process, 'exit');

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(capture, 'utf8')).toBe(JSON.stringify(expectation));
  });
});
