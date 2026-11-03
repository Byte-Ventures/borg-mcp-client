// Explicit native regression: no initialize, user prompt or model generation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultApprovalIo, readCodexEffectiveConfig, resolveLaunchBorgApprovals } from '../../dist/cli-tool-approval.js';
import { readClaudeEffectiveSettings } from '../../dist/claude-effective-settings.js';
import { ToolNameMigrationError } from '../../dist/tool-name-migration.js';

const claudeBinary = process.env.CLAUDE_TEST_BINARY;
const codexBinary = process.env.CODEX_TEST_BINARY;
assert.ok(claudeBinary || codexBinary, 'Set CLAUDE_TEST_BINARY and/or CODEX_TEST_BINARY');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-native-policy-')));
const config = join(root, '.claude'); mkdirSync(config);
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config, CODEX_HOME: join(root, '.codex'),
  XDG_CONFIG_HOME: join(root, '.config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
try {
  if (claudeBinary) {
    const marker = join(root, 'hook-must-not-run');
    const oldName = 'mcp__borg__borg_remove-document', newName = 'mcp__borg__borg_remove_document';
    const handler = { type: 'command', command: `node -e "require('node:fs').writeFileSync(process.env.BORG_FIXTURE_HOOK_MARKER,'ran')"` };
    env.BORG_FIXTURE_HOOK_MARKER = marker;
    const hooks = { SessionStart: [{ hooks: [handler] }], SessionEnd: [{ hooks: [handler] }] };
    const settingsPath = join(config, 'settings.json');
    const base = { permissions: { deny: [oldName, newName, 'mcp__borg__borg_tool'] }, hooks };
    writeFileSync(settingsPath, JSON.stringify(base));
    const read = async (args, cwd, childEnv) => {
      let closed;
      const result = await readClaudeEffectiveSettings(args, cwd, childEnv, { spawnProcess: (_command, argv, options) => {
        assert.ok(argv.includes('--bare'));
        assert.ok(!argv.includes('--agent') && !argv.includes('--agents') && !argv.includes('--plugin-dir'));
        const child = spawn(claudeBinary, argv, options);
        closed = new Promise(resolve => child.once('close', resolve));
        return child;
      } });
      await closed;
      assert.equal(existsSync(marker), false, 'Inspection executes neither SessionStart nor SessionEnd hooks');
      assert.ok(JSON.stringify(result).includes(oldName), 'Bare inspection retains permission sources');
      return result;
    };
    const launch = args => resolveLaunchBorgApprovals('claude', defaultApprovalIo(async () => '', () => false,
      { cwd: root, env, claudeArgs: args, loadClaude: read }));
    // Explicit settings must also remain data; their hooks must not execute.
    await launch(['--settings', JSON.stringify({ hooks })]);
    writeFileSync(settingsPath, JSON.stringify({ ...base, hooks: { ...hooks, PreToolUse: [{ matcher: oldName, hooks: [handler] }] } }));
    await assert.rejects(launch([]), ToolNameMigrationError);
    writeFileSync(settingsPath, JSON.stringify(base));
    mkdirSync(join(config, 'agents'));
    const agent = join(config, 'agents', 'safety.md');
    writeFileSync(agent, `---\nname: safety\ndescription: Native fixture\ndisallowedTools: ${oldName}\n---\nFixture.\n`);
    await assert.rejects(launch(['--agent', 'safety']), ToolNameMigrationError);
    writeFileSync(agent, `---\nname: safety\ndescription: Native fixture\ndisallowedTools: [${oldName}, ${newName}]\n---\nFixture.\n`);
    await launch(['--agent', 'safety']);
    await assert.rejects(launch(['--agents', JSON.stringify({ safety: { description: 'Fixture', prompt: 'Fixture', disallowedTools: [oldName] } })]), ToolNameMigrationError);
    await assert.rejects(launch(['--allowedTools', newName, '--disallowedTools', oldName, 'mcp__borg__borg_tool']), ToolNameMigrationError);
    assert.equal(existsSync(marker), false);
    console.log('Claude: native settings preserved; hooks never executed; hook, agent and CLI mismatches refused.');
  }
  if (codexBinary) {
    mkdirSync(env.CODEX_HOME);
    writeFileSync(join(env.CODEX_HOME, 'config.toml'), '[mcp_servers.borg]\ncommand="fixture-do-not-run"\ndefault_tools_approval_mode="approve"\n');
    const io = defaultApprovalIo(async () => '', () => false, { cwd: root, env, codexArgs: [],
      loadCodex: (args, cwd, childEnv, profile) => readCodexEffectiveConfig(args, cwd, childEnv,
        { profile, spawnProcess: (_command, argv, options) => spawn(codexBinary, argv, options) }) });
    for (let run = 0; run < 10; run++) {
      const decision = await resolveLaunchBorgApprovals('codex', io);
      assert.equal(decision.codexArgs.length, 2, 'Native unordered tool maps retain the launch approval override');
      assert.ok(decision.codexArgs[1].includes('borg:read_log') && decision.codexArgs[1].includes('borg:read-log'));
    }
    console.log('Codex: 10/10 native configuration/approval probes retained equivalent alias approvals.');
  }
} finally { rmSync(root, { recursive: true, force: true }); }
