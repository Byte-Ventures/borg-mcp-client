import { spawn } from 'node:child_process';

/** Forward only settings-source switches. Passing a prompt, --resume, or a
 * print flag to this probe could start a generation. No initialize/user frame
 * is sent: get_settings reads native merged and per-source policy only. */
export function claudeSettingsArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index];
    if (arg === '--settings' || arg === '--setting-sources') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error('Claude settings flag has no value');
      result.push(arg, value);
    } else if (arg.startsWith('--settings=') || arg.startsWith('--setting-sources=')) result.push(arg);
    else if (['--bare', '--restricted', '--safe-mode'].includes(arg)) result.push(arg);
  }
  return result;
}

/** CLI tool selectors do not necessarily appear in get_settings. Inspect only
 * their flags, never a prompt or unrelated argument that mentions a tool. */
export function claudeToolPolicyArgs(args: readonly string[]): string[] {
  const selectors: string[] = [];
  const flags = new Set(['--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools']);
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const [flag, inline] = args[index].split(/=(.*)/s);
    if (!flags.has(flag)) continue;
    const values: string[] = [];
    if (inline !== undefined) values.push(inline);
    else while (index + 1 < args.length && !args[index + 1].startsWith('-')) values.push(args[++index]);
    for (const value of values) {
      let token = '', depth = 0, quote = '', escaped = false;
      for (const character of value) {
        if (escaped) { token += character; escaped = false; continue; }
        if (character === '\\') { token += character; escaped = true; continue; }
        if (quote) { token += character; if (character === quote) quote = ''; continue; }
        if (depth && (character === '"' || character === "'")) { token += character; quote = character; continue; }
        if (character === '(') depth++;
        if (character === ')') depth--;
        if (!depth && /[\s,]/.test(character)) {
          if (token) selectors.push(token);
          token = '';
        } else token += character;
      }
      if (depth || quote || escaped) throw new Error('Claude tool selector could not be inspected');
      if (token) selectors.push(token);
    }
  }
  return selectors;
}

export async function readClaudeEffectiveSettings(
  args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  runtime: { spawnProcess?: typeof spawn; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<unknown> {
  const selected = claudeSettingsArgs(args);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (runtime.spawnProcess ?? spawn)('claude', [...selected, '--print', '--input-format', 'stream-json',
        '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
      { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { reject(new Error('Claude effective-settings query failed')); return; }
    let settled = false;
    let buffer = '';
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch { /* query has already settled */ }
      if (value !== undefined) resolve(value);
      else reject(new Error('Claude effective-settings query failed'));
    };
    if (!child.stdin || !child.stdout) { finish(); return; }
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stdout.on('error', () => finish());
    child.stdout.on('data', chunk => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > (runtime.maxResponseBytes ?? 4 * 1024 * 1024)) { finish(); return; }
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { finish(); return; }
        if (message?.type !== 'control_response' || message.response?.request_id !== 'borg-settings') continue;
        const value = message.response?.response;
        if (message.response.subtype !== 'success' || !value || typeof value.effective !== 'object' ||
          value.effective === null || Array.isArray(value.effective) || !Array.isArray(value.sources)) { finish(); return; }
        finish(value);
      }
    });
    timer = setTimeout(() => finish(), runtime.timeoutMs ?? 10_000);
    child.stdin.on('error', () => finish());
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'borg-settings', request: { subtype: 'get_settings' } }) + '\n',
        error => { if (error) finish(); });
    } catch { finish(); }
  });
}
