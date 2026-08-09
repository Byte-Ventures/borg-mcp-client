export const LOG_AUDIT_NUDGE = (count: number): string =>
  `Heads up: ${count}+ state-changing tool calls since the last \`borg_log\` post. ` +
  'If that work was a substantive unit (a change that ships, a blocker hit, a finding ' +
  "worth sharing), post to the cube log per your role's conventions before continuing.";

/**
 * Pure transcript scan shared by the Claude hook and the OpenCode plugin.
 * Accepts both Claude JSONL entries and OpenCode SDK message records.
 */
export function evaluateLogAudit(
  entries: readonly any[],
  renderNudge: (count: number) => string = (count) =>
    `Heads up: ${count}+ state-changing tool calls since the last \`borg_log\` post. ` +
    'If that work was a substantive unit (a change that ships, a blocker hit, a finding ' +
    "worth sharing), post to the cube log per your role's conventions before continuing.",
): string | null {
  const materialTools = new Set([
    'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash',
    'edit', 'write', 'bash', 'apply_patch', 'exec_command',
    'functions.exec_command', 'functions.apply_patch',
  ]);
  const logTools = new Set(['mcp__borg__borg_log', 'borg_borg_log']);
  const threshold = 3;
  const maxScan = 400;

  const role = (entry: any): unknown =>
    entry?.type ?? entry?.role ?? entry?.info?.role;
  const parts = (entry: any): any[] => {
    const value = entry?.message?.content ?? entry?.content ?? entry?.parts ?? [];
    return Array.isArray(value) ? value : [];
  };
  const isUserPrompt = (entry: any): boolean => {
    if (role(entry) !== 'user') return false;
    const content = entry?.message?.content ?? entry?.content ?? entry?.parts;
    if (typeof content === 'string') return content.trim().length > 0;
    return Array.isArray(content) && content.some((part) =>
      part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
    );
  };
  const isAssistant = (entry: any): boolean => {
    const value = role(entry);
    return value === 'assistant' || value === 'response_item';
  };
  const toolName = (part: any): string | null => {
    if (part?.type === 'tool_use' && typeof part.name === 'string') return part.name;
    if ((part?.type === 'tool' || part?.type === 'tool_call') && typeof part.tool === 'string') {
      return part.tool;
    }
    return null;
  };

  let index = entries.length - 1;
  if (index >= 0 && isUserPrompt(entries[index])) index--;
  let material = 0;
  let scanned = 0;
  for (; index >= 0 && scanned < maxScan; index--, scanned++) {
    const entry = entries[index];
    if (!isAssistant(entry)) continue;

    const payload = entry?.payload;
    const payloadTool =
      payload?.type === 'function_call' || payload?.type === 'custom_tool_call'
        ? payload.name
        : null;
    if (typeof payloadTool === 'string') {
      if (logTools.has(payloadTool)) return material >= threshold ? renderNudge(material) : null;
      if (materialTools.has(payloadTool)) material++;
      if (material >= threshold) return renderNudge(material);
    }

    const content = parts(entry);
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const name = toolName(content[partIndex]);
      if (!name) continue;
      if (logTools.has(name)) return material >= threshold ? renderNudge(material) : null;
      if (materialTools.has(name)) material++;
      if (material >= threshold) return renderNudge(material);
    }
  }
  return null;
}
