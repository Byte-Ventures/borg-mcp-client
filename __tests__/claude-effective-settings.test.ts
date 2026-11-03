import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { claudeSettingsArgs, claudeToolPolicyArgs, readClaudeEffectiveSettings } from '../src/claude-effective-settings.js';

function fixture() {
  const child = new EventEmitter() as any;
  child.stdin = new EventEmitter(); child.stdin.write = vi.fn();
  child.stdout = new EventEmitter(); child.kill = vi.fn();
  const spawnProcess = vi.fn(() => child);
  return { child, spawnProcess };
}
describe('native Claude policy query', () => {
  it('checks CLI tool selectors without interpreting prompt text as policy', () => {
    expect(claudeToolPolicyArgs(['mention mcp__borg__borg_read-log in the answer'])).toEqual([]);
    expect(claudeToolPolicyArgs(['--disallowedTools=mcp__borg__borg_read-log', '--allowed-tools', 'mcp__borg__borg_stream-status,mcp__borg__borg_log', '--', '--tools=mcp__borg__borg_read-entry']))
      .toEqual(['mcp__borg__borg_read-log', 'mcp__borg__borg_stream-status', 'mcp__borg__borg_log']);
    expect(claudeToolPolicyArgs(['--disallowedTools', '*read-*', 'Bash(echo mcp__borg__borg_read-log)', '--model', 'x']))
      .toEqual(['*read-*', 'Bash(echo mcp__borg__borg_read-log)']);
  });
  it('forwards settings sources and excludes prompt, resume, model and generation flags', () => {
    expect(claudeSettingsArgs(['--resume', 'private-session', '--model', 'model', '--settings', '{"permissions":{}}', '--setting-sources=user,project', '--safe-mode', 'prompt', '--', '--settings=ignored']))
      .toEqual(['--settings', '{"permissions":{}}', '--setting-sources=user,project', '--safe-mode']);
    expect(() => claudeSettingsArgs(['--settings'])).toThrow();
  });
  it('reads effective and managed source settings with no initialize or user frame', async () => {
    const { child, spawnProcess } = fixture();
    const result = readClaudeEffectiveSettings(['--settings', '{}'], '/worktree', { HOME: '/fixture' }, { spawnProcess: spawnProcess as any });
    const frame = JSON.parse(child.stdin.write.mock.calls[0][0]);
    expect(frame.request).toEqual({ subtype: 'get_settings' });
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][1]).toContain('--no-session-persistence');
    const settings = { effective: { permissions: { deny: ['mcp__borg__borg_read_log'] } }, sources: [{ source: 'policySettings', settings: { permissions: { deny: ['mcp__borg__borg_read-log'] } } }] };
    child.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: settings } }) + '\n');
    expect(await result).toEqual(settings);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it.each(['spawn', 'exit', 'malformed', 'unavailable', 'overflow', 'timeout', 'pipe', 'stdout'])('fails closed on %s without leaking native output', async failure => {
    const { child, spawnProcess } = fixture();
    const result = readClaudeEffectiveSettings([], '/worktree', {}, { spawnProcess: spawnProcess as any, timeoutMs: 5, maxResponseBytes: 1024 });
    const assertion = expect(result).rejects.toThrow('Claude effective-settings query failed');
    if (failure === 'spawn') child.emit('error', new Error('secret'));
    if (failure === 'exit') child.emit('close', 1);
    if (failure === 'malformed') child.stdout.emit('data', 'secret-not-json\n');
    if (failure === 'unavailable') child.stdout.emit('data', '{"type":"control_response","response":{"request_id":"borg-settings","subtype":"error","error":"secret"}}\n');
    if (failure === 'overflow') child.stdout.emit('data', 's'.repeat(1025));
    if (failure === 'pipe') child.stdin.emit('error', new Error('secret'));
    if (failure === 'stdout') child.stdout.emit('error', new Error('secret'));
    await assertion;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
