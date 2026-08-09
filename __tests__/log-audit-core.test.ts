import { describe, expect, it } from 'vitest';
import { evaluateLogAudit, LOG_AUDIT_NUDGE } from '../src/log-audit-core';

describe('evaluateLogAudit', () => {
  it('nudges after three OpenCode material tool parts', () => {
    expect(evaluateLogAudit([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'work' }] },
      { info: { role: 'assistant' }, parts: [
        { type: 'tool', tool: 'bash' },
        { type: 'tool', tool: 'edit' },
        { type: 'tool', tool: 'write' },
      ] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'next' }] },
    ])).toBe(LOG_AUDIT_NUDGE(3));
  });

  it('treats an OpenCode borg log call as cooldown', () => {
    expect(evaluateLogAudit([
      { info: { role: 'assistant' }, parts: [
        { type: 'tool', tool: 'bash' },
        { type: 'tool', tool: 'edit' },
        { type: 'tool', tool: 'write' },
        { type: 'tool', tool: 'borg_borg_log' },
      ] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'next' }] },
    ])).toBeNull();
  });

  it('preserves Claude tool_use and payload compatibility', () => {
    expect(evaluateLogAudit([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash' },
        { type: 'tool_use', name: 'Edit' },
      ] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'next' }] } },
    ])).toBe(LOG_AUDIT_NUDGE(3));
  });
});
