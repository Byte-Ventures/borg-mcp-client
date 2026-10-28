import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { fs } from './guarded-fs.js';
import { borgHomeRoot, isCanonicalPath } from './private-root.js';
import { OPENCODE_SERVER_PASSWORD_REFERENCE } from './opencode-launch-trust.js';

function readDocument(filename: string): { source: string; config: any } {
  if (!isCanonicalPath(filename)) throw new Error('OpenCode config path contains a symlink.');
  const source = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '{}\n';
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenCode global config is not a valid JSONC object.');
  return { source, config };
}

function writeDocument(filename: string, source: string, updated: string): void {
  if (updated === source) return;
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.borg-${randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, updated, { flag: 'wx', mode: 0o600 });
    if (!isCanonicalPath(filename) || (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') !== source)) throw new Error('OpenCode config changed while writing. Retry the command.');
    fs.renameSync(temp, filename);
  } finally { fs.rmSync(temp, { force: true }); }
}

function documents(configPath: string) {
  const names = ['config.json', 'opencode.json', 'opencode.jsonc'];
  const filenames = names.includes(path.basename(configPath)) ? names.map(name => path.join(path.dirname(configPath), name)) : [configPath];
  return filenames.filter(filename => fs.existsSync(filename)).map(filename => ({ filename, ...readDocument(filename) }));
}

function managedEntries(config: any): { key: string[]; entry: any }[] {
  return [{ key: ['mcp', 'borg'], entry: config.mcp?.borg }, { key: ['mcp', 'servers', 'borg'], entry: config.mcp?.servers?.borg }]
    .filter(({ entry }) => entry?.type === 'local' &&
      ((entry.environment ?? entry.env)?.BORG_AGENT_KIND === 'opencode' || (entry.environment ?? entry.env)?.BORG_OPENCODE === '1'));
}

export function readManagedOpenCodeMcpCommands(configPath: string): unknown[] {
  return documents(configPath).flatMap(({ config }) => managedEntries(config).map(({ entry }) => entry.command));
}

/** Update owned commands in either shape without enabling or converting them. */
export function refreshManagedOpenCodeMcpCommands(configPath: string, stale: (command: unknown) => boolean, command: string): void {
  for (const { filename, source, config } of documents(configPath)) {
    let updated = source;
    for (const { key, entry } of managedEntries(config)) if (stale(entry.command)) {
      updated = applyEdits(updated, modify(updated, [...key, 'command'], Array.isArray(entry.command) ? [command] : command, {}));
    }
    writeDocument(filename, source, updated);
  }
}

/** Setup writes the intersection of V1/V2 config, never V2-only global fields. */
export function registerCommonOpenCodeMcp(homeDir = borgHomeRoot(), env: NodeJS.ProcessEnv = process.env): void {
  const directory = path.join(homeDir, '.config', 'opencode');
  const filename = path.join(directory, 'opencode.jsonc');
  const { source, config } = readDocument(filename);
  const entry = { ...config.mcp?.borg, type: 'local', command: ['borg-mcp'], enabled: true,
    environment: { ...config.mcp?.borg?.environment, BORG_SESSION: '1', BORG_AGENT_KIND: 'opencode', BORG_OPENCODE: '1',
      OPENCODE_SERVER_PASSWORD: OPENCODE_SERVER_PASSWORD_REFERENCE,
      BORG_LAUNCH_EXPECTED_SEAT: '{env:BORG_LAUNCH_EXPECTED_SEAT}',
      ...(env.BORG_STATE_ROOT ? { BORG_STATE_ROOT: env.BORG_STATE_ROOT } : {}),
      ...(env.BORG_API_URL ? { BORG_API_URL: env.BORG_API_URL } : {}),
    } };
  const updated = applyEdits(source, modify(source, ['mcp', 'borg'], entry, {}));
  writeDocument(filename, source, updated);
}
