import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureResolvedCliConfigured,
  launchOpenCodeProcess,
  OpenCodeTargetedLaunchConfigError,
} from '../src/claude';
import {
  BORG_LAUNCH_EXPECTED_SEAT_ENV,
  withLaunchSeatExpectationEnv,
} from '../src/cubes';
import { ensureCliMcpConfigured } from '../src/ensure-mcp-config';
import { createOpenCodeLaunchKickoff } from '../src/opencode-drone';

const originalPath = process.env.PATH;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const originalExpectedSeat = process.env.BORG_LAUNCH_EXPECTED_SEAT;
const originalOpenCodeCalls = process.env.BORG_TEST_OPENCODE_CALLS;
const originalOpenCodeMode = process.env.BORG_TEST_OPENCODE_MODE;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  if (originalExpectedSeat === undefined) delete process.env.BORG_LAUNCH_EXPECTED_SEAT;
  else process.env.BORG_LAUNCH_EXPECTED_SEAT = originalExpectedSeat;
  if (originalOpenCodeCalls === undefined) delete process.env.BORG_TEST_OPENCODE_CALLS;
  else process.env.BORG_TEST_OPENCODE_CALLS = originalOpenCodeCalls;
  if (originalOpenCodeMode === undefined) delete process.env.BORG_TEST_OPENCODE_MODE;
  else process.env.BORG_TEST_OPENCODE_MODE = originalOpenCodeMode;
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
// OpenCode 1.18.15 seeds opencode.jsonc before mcp add, so the command
// updates that existing global file rather than creating opencode.json.
const configPath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc');
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
const configText = fs.readFileSync(configPath, 'utf8');
const substitutedConfig = configText.replace(
  /\{env:([^}]+)\}/g,
  (_match, name) => process.env[name] ?? '',
);
const server = JSON.parse(substitutedConfig).mcp.borg;
const environment = server.environment;
const inheritedEnvironment = { ...process.env };
delete inheritedEnvironment.BORG_LAUNCH_EXPECTED_SEAT;
const child = spawnSync(server.command[0], server.command.slice(1), {
  env: { ...inheritedEnvironment, ...environment },
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
`);
    writeExecutable(path.join(bin, 'borg-mcp'), String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.env.BORG_TEST_CAPTURE, JSON.stringify({
  expectedSeat: process.env.BORG_LAUNCH_EXPECTED_SEAT ?? '<missing>',
  apiUsername: process.env.OPENCODE_SERVER_USERNAME ?? '<missing>',
  apiPassword: process.env.OPENCODE_SERVER_PASSWORD ?? '<missing>',
}));
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
    process.env.BORG_LAUNCH_EXPECTED_SEAT =
      withLaunchSeatExpectationEnv({}, expectation).BORG_LAUNCH_EXPECTED_SEAT;
    const configPath = path.join(root, '.config', 'opencode', 'opencode.jsonc');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { borg: { type: 'local', command: ['borg-mcp'], environment: { BORG_SESSION: '1' } } },
    }));
    expect(ensureCliMcpConfigured('opencode')).toBe(true);

    const kickoff = createOpenCodeLaunchKickoff('kickoff');
    const launched = await launchOpenCodeProcess({
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
      injectKickoff: async () => true,
    });
    const [exitCode] = await once(launched.process, 'exit');

    expect(exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, 'utf8'))).toEqual({
      expectedSeat: Buffer.from(JSON.stringify(expectation), 'utf8').toString('base64url'),
      apiUsername: 'opencode',
      apiPassword: launched.launchEnv.OPENCODE_SERVER_PASSWORD,
    });
    expect(Buffer.from(String(launched.launchEnv.OPENCODE_SERVER_PASSWORD), 'base64url')).toHaveLength(32);
  });

  it.each(['failed', 'ineffective'] as const)(
    'refuses a targeted launch when OpenCode registration self-heal is %s',
    (mode) => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-opencode-refusal-')));
      roots.push(root);
      const bin = path.join(root, 'bin');
      const calls = path.join(root, 'opencode-calls');
      fs.mkdirSync(bin);
      writeExecutable(path.join(bin, 'opencode'), String.raw`
const fs = require('node:fs');
fs.appendFileSync(process.env.BORG_TEST_OPENCODE_CALLS, JSON.stringify(process.argv.slice(2)) + '\n');
process.exit(process.env.BORG_TEST_OPENCODE_MODE === 'failed' ? 2 : 0);
`);

      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
      process.env.BORG_STATE_ROOT = root;
      process.env.BORG_TEST_OPENCODE_CALLS = calls;
      process.env.BORG_TEST_OPENCODE_MODE = mode;
      const expectation = {
        credentialRef: `borg-server-session:${'a'.repeat(64)}`,
        cubeId: '11111111-1111-4111-8111-111111111111',
        droneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        worktree: '/work/a',
        droneLabel: 'builder-aaaaaaaa',
      };
      process.env.BORG_LAUNCH_EXPECTED_SEAT =
        withLaunchSeatExpectationEnv({}, expectation).BORG_LAUNCH_EXPECTED_SEAT;
      const configPath = path.join(root, '.config', 'opencode', 'opencode.jsonc');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        mcp: { borg: { type: 'local', command: ['borg-mcp'], environment: { BORG_SESSION: '1' } } },
      }));

      expect(() => ensureResolvedCliConfigured('opencode', {
        cubeId: expectation.cubeId,
        droneId: expectation.droneId,
        name: 'alpha',
        sessionToken: 'unused',
        droneLabel: expectation.droneLabel,
        apiUrl: 'https://127.0.0.1:31337',
        worktree: expectation.worktree,
      })).toThrow(new OpenCodeTargetedLaunchConfigError(
        expectation.droneLabel,
        expectation.worktree,
      ));
      const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(invocations).toHaveLength(1);
      expect(invocations[0].slice(0, 3)).toEqual(['mcp', 'add', 'borg']);

      delete process.env.BORG_LAUNCH_EXPECTED_SEAT;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => ensureResolvedCliConfigured('opencode')).not.toThrow();
      // The targeted marker is optional for an ordinary launch, but the API
      // password substitution is mandatory for every OpenCode MCP child.
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    },
  );
});
