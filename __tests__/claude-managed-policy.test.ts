import { expect, it } from 'vitest';
import { claudeManagedAgentDirectory } from '../src/claude-managed-policy.js';

it.each([
  ['darwin', '/Library/Application Support/ClaudeCode/.claude/agents'],
  ['linux', '/etc/claude-code/.claude/agents'], // WSL uses the Linux CLI/directory.
  ['win32', 'C:\\Program Files\\ClaudeCode\\.claude\\agents'],
] as const)('uses the native %s managed definition directory', (platform, expected) => {
  expect(claudeManagedAgentDirectory(platform)).toBe(expected);
});
