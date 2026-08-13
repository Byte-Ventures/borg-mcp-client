/**
 * MCP Settings Configuration Utilities
 *
 * Handles adding borg-mcp to Claude Code via the claude CLI
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  BORG_AGENT_KIND_ENV,
  BORG_CODEX_REMOTE_WAKE_ENV,
  withAgentRuntimeEnv,
} from './agent-runtime.js';
import {
  resolveRegenPath,
  resolveClearRewakePath,
  resolveLogAuditPath,
  resolveForeignPathReminderPath,
} from './self-path.js';
import { shellEscape } from './shell-escape.js';
import { BORG_STATE_ROOT_ENV, borgAgentConfigEnv, borgHomeRoot } from './private-root.js';
import type { LaunchAccessPaths } from './launch-access.js';
import { BORG_LAUNCH_EXPECTED_SEAT_ENV } from './cubes.js';
import {
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_PASSWORD_REFERENCE,
} from './opencode-launch-trust.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// client#394: hook commands are stable npm bin names. They intentionally stay
// unquoted: each is a fixed single shell token with no metacharacters. Legacy
// quoted bare names and install-specific absolute paths migrate to this form.
const HOOK_COMMAND = 'borg-regen';
const CLEAR_REWAKE_HOOK_COMMAND = 'borg-clear-rewake';
const AUDIT_HOOK_COMMAND = 'borg-log-audit';
const FOREIGN_PATH_REMINDER_HOOK_COMMAND = 'borg-foreign-path-reminder';
const MCP_COMMAND = 'borg-mcp';
const OPENCODE_LAUNCH_EXPECTED_SEAT_REFERENCE = `{env:${BORG_LAUNCH_EXPECTED_SEAT_ENV}}`;

/**
 * Claude Code CLI config path. The CLI reads `mcpServers.<name>` from
 * this file to discover registered MCP servers; `addMcpServer()` (below)
 * writes to it via the `claude mcp add --scope user borg borg-mcp` shell
 * command. Server name is `borg` (not `borgmcp` — `borg-mcp` is the
 * binary that backs it). NOTE: distinct from
 * `~/Library/Application Support/Claude/claude_desktop_config.json`,
 * which is the Claude Desktop app's config (different product).
 */
const CONFIG_HOME = borgHomeRoot();
const CLAUDE_CONFIG_PATH = path.join(CONFIG_HOME, '.claude.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_HOME, '.codex', 'config.toml');
const CODEX_HOOKS_PATH = path.join(CONFIG_HOME, '.codex', 'hooks.json');
const OPENCODE_CONFIG_PATH = path.join(CONFIG_HOME, '.config', 'opencode', 'opencode.json');
const OPENCODE_GLOBAL_CONFIG_FILENAMES = ['config.json', 'opencode.json', 'opencode.jsonc'] as const;
const MCP_SERVER_NAME = 'borg';

function settingsPath(): string {
  return path.join(CONFIG_HOME, '.claude', 'settings.json');
}

function readSettings(): any {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  const text = fs.readFileSync(p, 'utf-8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function writeSettings(settings: any): void {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function readJsonFile(p: string): any {
  if (!fs.existsSync(p)) return {};
  const text = fs.readFileSync(p, 'utf-8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function parseJsonc(text: string): unknown {
  let stripped = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        stripped += char;
      } else {
        stripped += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        stripped += '  ';
        index++;
        blockComment = false;
      } else {
        stripped += char === '\n' || char === '\r' ? char : ' ';
      }
      continue;
    }
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === '/' && next === '/') {
      stripped += '  ';
      index++;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      stripped += '  ';
      index++;
      blockComment = true;
      continue;
    }
    stripped += char;
  }

  if (inString || blockComment) throw new SyntaxError('unterminated JSONC token');

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index++) {
    const char = stripped[index];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/.test(stripped[lookahead] ?? '')) lookahead++;
      if (stripped[lookahead] === '}' || stripped[lookahead] === ']') continue;
    }
    withoutTrailingCommas += char;
  }

  return JSON.parse(withoutTrailingCommas.replace(/^\uFEFF/, ''));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeOpenCodeConfigValue(target: unknown, source: unknown): unknown {
  if (!isPlainRecord(target) || !isPlainRecord(source)) return source;
  const merged = Object.assign(Object.create(null) as Record<string, unknown>, target);
  for (const [key, value] of Object.entries(source)) {
    merged[key] = key in merged ? mergeOpenCodeConfigValue(merged[key], value) : value;
  }
  return merged;
}

function readOpenCodeGlobalConfig(configPath: string): Record<string, unknown> {
  const basename = path.basename(configPath);
  const paths = OPENCODE_GLOBAL_CONFIG_FILENAMES.includes(
    basename as typeof OPENCODE_GLOBAL_CONFIG_FILENAMES[number],
  )
    ? OPENCODE_GLOBAL_CONFIG_FILENAMES.map((filename) => path.join(path.dirname(configPath), filename))
    : [configPath];
  let merged: unknown = {};
  for (const candidate of paths) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf-8');
    if (text.length === 0) continue;
    const parsed = parseJsonc(text);
    if (!isPlainRecord(parsed)) throw new TypeError(`OpenCode config is not an object: ${candidate}`);
    merged = mergeOpenCodeConfigValue(merged, parsed);
  }
  if (!isPlainRecord(merged)) throw new TypeError('OpenCode global config is not an object');
  return merged;
}

function writeJsonFile(p: string, data: any): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Register a Claude Code SessionStart hook that runs `borg-regen` at the
 * start of every session. Idempotent: re-running won't add duplicates.
 *
 * Returns true if a change was made, false otherwise (already present, or
 * settings.json could not be parsed).
 */
export function addSessionStartHook(): boolean {
  return addSessionStartHookAt(settingsPath());
}

/**
 * gh#673 P2 (WI-1): install the borg-regen SessionStart hook into a
 * PROJECT-LOCAL `<projectRoot>/.claude/settings.local.json` instead of
 * the global ~/.claude/settings.json. The .local variant is
 * user-authored and uncommitted, so it neither imposes borg-regen on
 * collaborators nor trips committed-project-hook trust prompts
 * (V1-probed: Claude Code merges + fires hooks from it). Written by
 * `borg assimilate` (incl. into freshly spawned sibling worktrees) and
 * ensured on every bare `borg` launch. Idempotent; preserves unrelated
 * settings content; refuses to clobber an unparseable file.
 */
export function addProjectSessionStartHook(projectRoot: string): boolean {
  return addSessionStartHookAt(projectSettingsPath(projectRoot), true);
}

/**
 * Pre-authorize the exact worktree + scratch paths for a Claude seat and add
 * the native PreToolUse reminder. The permission layer remains authoritative;
 * the reminder is deliberately advisory and cannot veto a tool call.
 */
export function addClaudeLaunchAccess(
  projectRoot: string,
  paths: LaunchAccessPaths,
): boolean {
  const settingsFile = projectSettingsPath(projectRoot);
  let settings: any;
  try {
    settings = readJsonFile(settingsFile);
  } catch (err: any) {
    throw new Error(`Could not parse ${settingsFile}: ${err.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Claude settings ${settingsFile} is not an object`);
  }

  if (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) {
    if (settings.permissions !== undefined) {
      throw new Error(`Claude settings permissions in ${settingsFile} are not an object`);
    }
    settings.permissions = {};
  }
  const additionalDirectories = settings.permissions.additionalDirectories;
  if (additionalDirectories !== undefined && !Array.isArray(additionalDirectories)) {
    throw new Error(`Claude settings permissions.additionalDirectories in ${settingsFile} is not an array`);
  }

  const directories = [paths.worktree, paths.scratch].map((value) => path.resolve(value));
  const existingDirectories: unknown[] = Array.isArray(additionalDirectories)
    ? additionalDirectories
    : [];
  let changed = false;
  for (const directory of directories) {
    if (!existingDirectories.includes(directory)) {
      existingDirectories.push(directory);
      changed = true;
    }
  }
  if (settings.permissions.additionalDirectories !== existingDirectories) {
    settings.permissions.additionalDirectories = existingDirectories;
    changed = true;
  }

  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    if (settings.hooks !== undefined) {
      throw new Error(`Claude settings hooks in ${settingsFile} are not an object`);
    }
    settings.hooks = {};
  }
  settings.hooks.PreToolUse ??= [];
  if (!Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`Claude settings hooks.PreToolUse in ${settingsFile} is not an array`);
  }
  const entries = settings.hooks.PreToolUse;
  changed = migrateAndDedupOwnedHooks(entries) || changed;
  if (!hasCommandHook(entries, FOREIGN_PATH_REMINDER_HOOK_COMMAND)) {
    entries.push({
      matcher: '*',
      hooks: [{ type: 'command', command: FOREIGN_PATH_REMINDER_HOOK_COMMAND }],
    });
    changed = true;
  }

  if (changed) writeJsonFile(settingsFile, settings);
  return changed;
}

/** Peek variant of addProjectSessionStartHook — no mutation. */
export function isProjectSessionStartHookRegistered(projectRoot: string): boolean {
  return sessionStartHookRegisteredAt(projectSettingsPath(projectRoot), true);
}

function projectSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'settings.local.json');
}

function addSessionStartHookAt(settingsFile: string, includeClearRewake = false): boolean {
  let settings: any;
  try {
    settings = readJsonFile(settingsFile);
  } catch (err: any) {
    console.error(`⚠ Could not parse ${settingsFile}: ${err.message}. Skipping hook registration; you can add it manually.`);
    return false;
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  let changed = false;

  // gh#client#18: migrate owned hooks to canonical form and deduplicate
  // (exactly one canonical hook per owned command, preserving unrelated
  // siblings and entry metadata).
  changed = migrateAndDedupOwnedHooks(settings.hooks.SessionStart) || changed;

  if (!hasCommandHook(settings.hooks.SessionStart, HOOK_COMMAND)) {
    settings.hooks.SessionStart.push({
      matcher: '*',
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
    changed = true;
  }

  // Claude Code's normal orientation hook is intentionally left intact. A
  // second project-local handler matches only `/clear` and uses asyncRewake +
  // exit 2 to force one recovery turn when the otherwise-quiet SessionStart
  // event would leave the interactive session idle.
  if (includeClearRewake) {
    const normalized = normalizeClearRewakeHook(settings.hooks.SessionStart);
    if (normalized) {
      settings.hooks.SessionStart = normalized;
      changed = true;
    }
  }

  if (!changed) return false;

  writeJsonFile(settingsFile, settings);
  return true;
}

// Match stable bare names plus legacy install-specific absolute forms.
function commandMatches(entryCommand: string, bareName: string, absolutePath: string): boolean {
  const escaped = shellEscape(absolutePath);
  if (entryCommand === escaped || entryCommand === absolutePath || entryCommand === bareName) return true;
  // gh#client#18: stale prior-install absolute paths (e.g.
  // /old/.../dist/regen.js) end with the same basename. Only match
  // when the command IS an absolute path ending with the bare name to
  // avoid false positives on unrelated commands like "run regen.js".
  if (entryCommand.startsWith('/') && entryCommand.endsWith(`/${bareName}`)) return true;
  return false;
}

/** gh#client#18: map an owned hook command to its canonical shell-escaped form.
 *  Returns null for non-owned commands. Ownership requires EXACTLY ONE of:
 *  (a) Exact bare bin name (borg-regen, borg-clear-rewake, borg-log-audit)
 *  (b) Exact match (raw or shell-escaped) of THIS installation's canonical
 *      absolute command — always owned, no marker required (fixes neutral-path
 *      false negatives that broke idempotency)
 *  (c) Foreign-install heuristic: absolute path ending in an owned basename
 *      immediately below an exact borgmcp|borg-mcp/dist package path
 *  This prevents false-positive ownership of unrelated scripts that happen
 *  to share a basename (e.g. /opt/custom-tool/regen.js). */
function ownedCanonical(command: string): string | null {
  const stripped = command.replace(/^'|'$/g, '');

  // (a) Exact bare name — always owned
  if (stripped === BARE_BORG_REGEN) return HOOK_COMMAND;
  if (stripped === BARE_CLEAR_REWAKE) return CLEAR_REWAKE_HOOK_COMMAND;
  if (stripped === BARE_LOG_AUDIT) return AUDIT_HOOK_COMMAND;
  if (stripped === BARE_FOREIGN_PATH_REMINDER) return FOREIGN_PATH_REMINDER_HOOK_COMMAND;

  // (b) Exact match of THIS installation's canonical command (raw or escaped)
  // — always owned, no marker check required
  if (command === HOOK_COMMAND || stripped === resolveRegenPath()) return HOOK_COMMAND;
  if (command === CLEAR_REWAKE_HOOK_COMMAND || stripped === resolveClearRewakePath()) return CLEAR_REWAKE_HOOK_COMMAND;
  if (command === AUDIT_HOOK_COMMAND || stripped === resolveLogAuditPath()) return AUDIT_HOOK_COMMAND;
  if (command === FOREIGN_PATH_REMINDER_HOOK_COMMAND || stripped === resolveForeignPathReminderPath()) return FOREIGN_PATH_REMINDER_HOOK_COMMAND;

  // (c) Foreign-install heuristic: require exact path segments shaped like a
  // package root. A substring such as /opt/borgmcp-tools/ is not ownership.
  const segments = stripped.split('/');
  const packageIndex = segments.length - 3;
  const packageShaped = packageIndex >= 0 &&
    (segments[packageIndex] === 'borgmcp' || segments[packageIndex] === 'borg-mcp') &&
    segments[packageIndex + 1] === 'dist' &&
    packageIndex + 2 === segments.length - 1;
  if (stripped.startsWith('/') && packageShaped) {
    const name = segments.at(-1) ?? '';
    if (name === 'regen.js') return HOOK_COMMAND;
    if (name === 'clear-rewake.js') return CLEAR_REWAKE_HOOK_COMMAND;
    if (name === 'log-audit.js') return AUDIT_HOOK_COMMAND;
    if (name === 'foreign-path-reminder.js') return FOREIGN_PATH_REMINDER_HOOK_COMMAND;
  }

  return null;
}

/**
 * gh#client#18: migrate owned hooks to canonical form and deduplicate:
 * exactly one canonical hook per owned command. Removes only duplicate owned
 * hook objects within entries, preserving unrelated siblings and entry metadata.
 * Mutates the entries array in place. Returns true if any change was made.
 */
function migrateAndDedupOwnedHooks(entries: any[]): boolean {
  let changed = false;

  // Phase 1: Migrate owned hooks to canonical form
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook?.type !== 'command' || typeof hook?.command !== 'string') continue;
      const canonical = ownedCanonical(hook.command);
      if (canonical && hook.command !== canonical) {
        hook.command = canonical;
        changed = true;
      }
    }
  }

  // Phase 2: Deduplicate — for each canonical command, keep exactly one hook
  // object across all entries. Remove only the duplicate hook objects, not
  // entire entries (preserving unrelated siblings and entry metadata).
  const seenCanonicals = new Set<string>();
  const emptiedByOwnedDedup = new Set<any>();
  for (const entry of entries) {
    if (!Array.isArray(entry?.hooks)) continue;
    const before = entry.hooks.length;
    entry.hooks = entry.hooks.filter((hook: any) => {
      if (hook?.type !== 'command' || typeof hook?.command !== 'string') return true;
      const canonical = ownedCanonical(hook.command);
      if (!canonical) return true;
      if (seenCanonicals.has(canonical)) {
        changed = true;
        return false;
      }
      seenCanonicals.add(canonical);
      return true;
    });
    if (entry.hooks.length !== before) changed = true;
    if (before > 0 && entry.hooks.length === 0) emptiedByOwnedDedup.add(entry);
  }

  // Phase 3: remove only entries emptied by removal of duplicate Borg-owned
  // hooks. Pre-existing empty or unusual operator entries remain byte-stable.
  for (let i = entries.length - 1; i >= 0; i--) {
    if (emptiedByOwnedDedup.has(entries[i])) {
      entries.splice(i, 1);
      changed = true;
    }
  }

  return changed;
}

export interface RefreshManagedAgentHookConfigOptions {
  homeDir?: string;
}

export interface ManagedAgentHookConfigHealth {
  path: string;
  status: 'absent' | 'ok' | 'stale' | 'invalid';
  detail?: string;
}

function globalManagedAgentHookConfigPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.codex', 'hooks.json'),
  ];
}

function realDirectory(pathname: string): boolean {
  try {
    const stat = fs.lstatSync(pathname);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Enumerate only Borg's canonical two-level managed-worktree layout. Every
 * traversed component must be a real directory; symlinks are never followed.
 */
export function managedAgentHookConfigPaths(homeDir: string = CONFIG_HOME): string[] {
  const paths = globalManagedAgentHookConfigPaths(homeDir);
  const borgDir = path.join(homeDir, '.borg');
  if (!realDirectory(borgDir)) return paths;
  const root = path.join(borgDir, 'worktrees');
  if (!realDirectory(root)) return paths;

  for (const repo of fs.readdirSync(root, { withFileTypes: true })) {
    const repoPath = path.join(root, repo.name);
    if (!repo.isDirectory() || !realDirectory(repoPath)) continue;
    for (const worktree of fs.readdirSync(repoPath, { withFileTypes: true })) {
      const worktreePath = path.join(repoPath, worktree.name);
      if (!worktree.isDirectory() || !realDirectory(worktreePath)) continue;
      const claudeDir = path.join(worktreePath, '.claude');
      if (!realDirectory(claudeDir)) continue;
      const settingsFile = path.join(claudeDir, 'settings.local.json');
      try {
        if (fs.lstatSync(settingsFile).isSymbolicLink()) continue;
      } catch {
        // No settings file in this canonical worktree; nothing to inventory.
        continue;
      }
      paths.push(settingsFile);
    }
  }
  return paths;
}

function refreshHookFile(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const config = readJsonFile(configPath);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('top-level value is not an object');
  }
  const hooks = config.hooks;
  if (hooks === undefined) return false;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new Error('hooks is not an object');
  }
  let changed = false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    changed = migrateAndDedupOwnedHooks(entries) || changed;
  }
  if (changed) writeJsonFile(configPath, config);
  return changed;
}

/**
 * Heal stale Borg-owned hook commands in global agent files and canonical
 * managed worktrees. Non-Borg hooks and noncanonical worktree roots are left
 * untouched. Later files are still attempted when one file is invalid.
 */
export function refreshManagedAgentHookConfigs(
  options: RefreshManagedAgentHookConfigOptions = {},
): string[] {
  const homeDir = options.homeDir ?? CONFIG_HOME;
  const refreshed: string[] = [];
  const failures: string[] = [];
  let configPaths = globalManagedAgentHookConfigPaths(homeDir);
  try {
    configPaths = managedAgentHookConfigPaths(homeDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`hook inventory ${path.join(homeDir, '.borg', 'worktrees')}: ${message}`);
  }
  for (const configPath of configPaths) {
    try {
      if (refreshHookFile(configPath)) refreshed.push(configPath);
    } catch (error) {
      const label = configPath.endsWith(path.join('.codex', 'hooks.json'))
        ? 'Codex'
        : 'Claude Code';
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label} ${configPath}: ${message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not refresh managed agent hooks: ${failures.join('; ')}`);
  }
  return refreshed;
}

/** Read-only mirror of the updater's stale-command predicate. */
export function inspectManagedAgentHookConfigs(
  homeDir: string = CONFIG_HOME,
): ManagedAgentHookConfigHealth[] {
  let configPaths = globalManagedAgentHookConfigPaths(homeDir);
  let inventoryIssue: ManagedAgentHookConfigHealth | null = null;
  try {
    configPaths = managedAgentHookConfigPaths(homeDir);
  } catch (error) {
    inventoryIssue = {
      path: path.join(homeDir, '.borg', 'worktrees'),
      status: 'invalid',
      detail: `inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const health = configPaths.map((configPath): ManagedAgentHookConfigHealth => {
    if (!fs.existsSync(configPath)) return { path: configPath, status: 'absent' };
    try {
      const config = readJsonFile(configPath);
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { path: configPath, status: 'invalid', detail: 'top-level value is not an object' };
      }
      if (config.hooks === undefined) return { path: configPath, status: 'ok' };
      if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
        return { path: configPath, status: 'invalid', detail: 'hooks is not an object' };
      }
      const copy = structuredClone(config.hooks);
      let stale = false;
      for (const entries of Object.values(copy)) {
        if (Array.isArray(entries)) stale = migrateAndDedupOwnedHooks(entries) || stale;
      }
      return { path: configPath, status: stale ? 'stale' : 'ok' };
    } catch (error) {
      return {
        path: configPath,
        status: 'invalid',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
  if (inventoryIssue) health.push(inventoryIssue);
  return health;
}

/** Strict canonical match. Quoted bare and legacy path forms are owned but
 * require migration before they count as the one current command form. */
function isCanonicalCommand(entryCommand: string, canonical: string): boolean {
  return entryCommand === canonical;
}

const BARE_BORG_REGEN = 'borg-regen';
const BARE_CLEAR_REWAKE = 'borg-clear-rewake';
const BARE_LOG_AUDIT = 'borg-log-audit';
const BARE_FOREIGN_PATH_REMINDER = 'borg-foreign-path-reminder';

function hasCommandHook(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h: any) => {
      if (h?.type !== 'command' || typeof h?.command !== 'string') return false;
      // gh#client#18: for known owned commands, check if this hook's command
      // maps to the SAME canonical as the target. This correctly distinguishes
      // regen from clear-rewake from audit — a clear-rewake hook does NOT
      // satisfy the dedup check for a regen target, and vice versa.
      if (command === HOOK_COMMAND || command === CLEAR_REWAKE_HOOK_COMMAND || command === AUDIT_HOOK_COMMAND || command === FOREIGN_PATH_REMINDER_HOOK_COMMAND) {
        return ownedCanonical(h.command) === command;
      }
      return h.command === command;
    })
  );
}

/** Strict: only the current unquoted bare canonical form. */
function hasCanonicalCommandHook(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h: any) => {
      if (h?.type !== 'command' || typeof h?.command !== 'string') return false;
      return isCanonicalCommand(h.command, command);
    })
  );
}

function isClearRewakeCommand(hook: any): boolean {
  if (hook?.type !== 'command' || typeof hook?.command !== 'string') return false;
  return commandMatches(hook.command, BARE_CLEAR_REWAKE, resolveClearRewakePath());
}

function isCanonicalClearRewakeEntry(entry: any): boolean {
  return entry?.matcher === 'clear' &&
    Array.isArray(entry?.hooks) &&
    entry.hooks.length === 1 &&
    isCanonicalCommand(entry.hooks[0].command, CLEAR_REWAKE_HOOK_COMMAND) &&
    entry.hooks[0].asyncRewake === true;
}

/**
 * Ensure one dedicated clear-only async-rewake handler. If a user has a
 * malformed or duplicate entry for our command, remove only that owned
 * command, preserve any unrelated sibling hooks, and append the canonical
 * entry once.
 */
function normalizeClearRewakeHook(entries: any[]): any[] | null {
  let migrated = false;
  const result = entries.map((entry: any) => {
    if (!Array.isArray(entry?.hooks)) return entry;
    const hooks = entry.hooks.map((hook: any) => {
      if (isClearRewakeCommand(hook) && !isCanonicalCommand(hook.command, CLEAR_REWAKE_HOOK_COMMAND)) {
        migrated = true;
        return { ...hook, command: CLEAR_REWAKE_HOOK_COMMAND };
      }
      return hook;
    });
    return hooks === entry.hooks ? entry : { ...entry, hooks };
  });

  const commandCount = result.reduce(
    (count, entry) => count + (
      Array.isArray(entry?.hooks) ? entry.hooks.filter(isClearRewakeCommand).length : 0
    ),
    0
  );
  if (commandCount === 1 && result.some(isCanonicalClearRewakeEntry)) {
    return migrated ? result : null;
  }

  const withoutOwnedCommand = result.flatMap((entry: any) => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: any) => !isClearRewakeCommand(hook));
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
  withoutOwnedCommand.push({
    matcher: 'clear',
    hooks: [{ type: 'command', command: CLEAR_REWAKE_HOOK_COMMAND, asyncRewake: true }],
  });
  return withoutOwnedCommand;
}

function sessionStartHookRegisteredAt(settingsFile: string, includeClearRewake = false): boolean {
  let settings: any;
  try {
    settings = readJsonFile(settingsFile);
  } catch {
    return false;
  }
  const arr = settings?.hooks?.SessionStart;
  if (!Array.isArray(arr)) return false;
  return hasCanonicalCommandHook(arr, HOOK_COMMAND) &&
    (!includeClearRewake || normalizeClearRewakeHook(arr) === null);
}

/**
 * Peek whether the borg-regen SessionStart hook is already registered, without
 * mutating settings. Returns false on any read error (safe-default).
 */
export function isSessionStartHookRegistered(): boolean {
  let settings: any;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  const arr = settings?.hooks?.SessionStart;
  if (!Array.isArray(arr)) return false;
  return arr.some((entry: any) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h: any) => {
      if (h?.type !== 'command' || typeof h?.command !== 'string') return false;
      return isCanonicalCommand(h.command, HOOK_COMMAND);
    })
  );
}

/**
 * Peek: true iff the Claude UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addUserPromptSubmitHook's idempotency
 * check; used by isClaudeHookConfigPending (gh#844).
 */
export function isUserPromptSubmitHookRegistered(): boolean {
  let settings: any;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  const arr = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(arr)) return false;
  return arr.some((entry: any) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h: any) => {
      if (h?.type !== 'command' || typeof h?.command !== 'string') return false;
      return isCanonicalCommand(h.command, AUDIT_HOOK_COMMAND);
    })
  );
}

/**
 * Inverse of addSessionStartHook: remove any SessionStart hook entry whose
 * inner hooks array contains a `borg-regen` command. If multiple commands
 * share an entry, only the borg-regen command is removed; otherwise the
 * entire entry is dropped. Empty containers are cleaned up.
 *
 * Returns true if a change was made, false otherwise.
 */
export function removeSessionStartHook(): boolean {
  let settings: any;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  if (!settings?.hooks?.SessionStart) return false;

  let changed = false;
  settings.hooks.SessionStart = settings.hooks.SessionStart
    .map((entry: any) => {
      if (!Array.isArray(entry?.hooks)) return entry;
      const filtered = entry.hooks.filter((h: any) => {
        if (h?.type !== 'command' || typeof h?.command !== 'string') return true;
        return !commandMatches(h.command, BARE_BORG_REGEN, HOOK_COMMAND);
      });
      if (filtered.length !== entry.hooks.length) {
        changed = true;
        return { ...entry, hooks: filtered };
      }
      return entry;
    })
    .filter((entry: any) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);

  if (settings.hooks.SessionStart.length === 0) {
    delete settings.hooks.SessionStart;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) writeSettings(settings);
  return changed;
}

/**
 * Register a Claude Code UserPromptSubmit hook that runs `borg-log-audit`
 * before each user prompt. The audit script nudges the drone if the
 * previous assistant span used state-changing tools without calling
 * `borg_log`. Idempotent: re-running won't add duplicates.
 *
 * Returns true if a change was made, false otherwise.
 */
export function addUserPromptSubmitHook(): boolean {
  let settings: any;
  try {
    settings = readSettings();
  } catch (err: any) {
    console.error(`⚠ Could not parse ${settingsPath()}: ${err.message}. Skipping audit hook registration.`);
    return false;
  }

  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];

  // gh#client#18: migrate owned hooks to canonical form and deduplicate
  // (exactly one canonical hook per owned command, preserving unrelated
  // siblings and entry metadata).
  let changed = migrateAndDedupOwnedHooks(settings.hooks.UserPromptSubmit);

  if (!hasCanonicalCommandHook(settings.hooks.UserPromptSubmit, AUDIT_HOOK_COMMAND)) {
    settings.hooks.UserPromptSubmit.push({
      matcher: '*',
      hooks: [{ type: 'command', command: AUDIT_HOOK_COMMAND }],
    });
    changed = true;
  }

  if (changed) writeSettings(settings);
  return changed;
}

/**
 * Inverse of addUserPromptSubmitHook: remove any UserPromptSubmit hook
 * entry that runs `borg-log-audit`. Symmetric cleanup to
 * removeSessionStartHook.
 */
export function removeUserPromptSubmitHook(): boolean {
  let settings: any;
  try {
    settings = readSettings();
  } catch {
    return false;
  }
  if (!settings?.hooks?.UserPromptSubmit) return false;

  let changed = false;
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
    .map((entry: any) => {
      if (!Array.isArray(entry?.hooks)) return entry;
      const filtered = entry.hooks.filter((h: any) => {
        if (h?.type !== 'command' || typeof h?.command !== 'string') return true;
        return !commandMatches(h.command, BARE_LOG_AUDIT, AUDIT_HOOK_COMMAND);
      });
      if (filtered.length !== entry.hooks.length) {
        changed = true;
        return { ...entry, hooks: filtered };
      }
      return entry;
    })
    .filter((entry: any) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);

  if (settings.hooks.UserPromptSubmit.length === 0) {
    delete settings.hooks.UserPromptSubmit;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) writeSettings(settings);
  return changed;
}

/**
 * Detect whether the borg MCP server is already registered in the Claude
 * Code CLI config (`~/.claude.json` `mcpServers.borg`).
 *
 * Per gh#79: when a user re-runs `borg setup` (the canonical re-run
 * reason), the setup wizard's "Add borg to Claude Code?"
 * prompt is redundant — the answer is deterministic ("already
 * configured"). This detect lets the wizard silently skip Step 1 entirely
 * when borg is present. Per the dispatch's Queen-implicit anti-scope,
 * "silent means silent" — callers must not log an "already configured"
 * notice when this returns true.
 *
 * Safe-default contract: any read error (file missing, malformed JSON,
 * permission denied, empty file, unexpected shape) returns `false` so
 * the caller still prompts. The dispatch's edge-case framing is "if
 * indeterminate → prompt fires" — never silent-skip when state is
 * ambiguous. The prompt is the safe path; silent-skip is the
 * optimization layered on top of a verified-present signal.
 *
 * @param configPath Override the config-file path; primarily for tests.
 */
export function isMcpServerConfigured(
  configPath: string = CLAUDE_CONFIG_PATH
): boolean {
  try {
    if (!fs.existsSync(configPath)) return false;
    const text = fs.readFileSync(configPath, 'utf-8');
    if (!text.trim()) return false;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return false;
    const servers = (parsed as any).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    return MCP_SERVER_NAME in servers;
  } catch {
    return false;
  }
}

export function isCodexMcpServerConfigured(
  configPath: string = CODEX_CONFIG_PATH
): boolean {
  try {
    if (!fs.existsSync(configPath)) return false;
    const text = fs.readFileSync(configPath, 'utf-8');
    const hasBorgServer = /^\s*\[mcp_servers\.borg\]\s*$/m.test(text);
    const hasPinnedCodexIdentity = new RegExp(
      `^\\s*${BORG_AGENT_KIND_ENV}\\s*=\\s*"codex"\\s*$`,
      'm'
    ).test(text);
    // gh#968 compatibility: older installations encoded the Codex CLI
    // identity using the remote-wake transport marker. Keep recognizing that
    // static shape so setup does not overwrite a working legacy config merely
    // to migrate its marker.
    const hasLegacyRemoteWakeIdentity = new RegExp(
      `^\\s*${BORG_CODEX_REMOTE_WAKE_ENV}\\s*=\\s*"1"\\s*$`,
      'm'
    ).test(text);
    return hasBorgServer && (hasPinnedCodexIdentity || hasLegacyRemoteWakeIdentity);
  } catch {
    return false;
  }
}

function configuredMcpCommand(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
}

function isStaleBorgMcpCommand(value: unknown): boolean {
  const command = configuredMcpCommand(value);
  if (!command || command === MCP_COMMAND || !path.isAbsolute(command)) return false;
  const normalized = command.replace(/\\/g, '/');
  return /\/(?:node_modules\/borgmcp|borg-mcp-client)\/dist\/index\.js$/.test(normalized);
}

function readClaudeMcpCommand(configPath: string): unknown {
  try {
    return readJsonFile(configPath)?.mcpServers?.[MCP_SERVER_NAME]?.command;
  } catch {
    return undefined;
  }
}

function readCodexMcpCommand(configPath: string): unknown {
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    if (!isCodexMcpServerConfigured(configPath)) return undefined;
    const header = /^\s*\[mcp_servers\.borg\]\s*$/m.exec(text);
    if (!header) return undefined;
    const tail = text.slice(header.index + header[0].length);
    const nextHeader = /^\s*\[/m.exec(tail);
    const section = nextHeader ? tail.slice(0, nextHeader.index) : tail;
    return section?.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];
  } catch {
    return undefined;
  }
}

function readOpenCodeMcpCommand(configPath: string): unknown {
  try {
    const borgServer = readJsonFile(configPath)?.mcp?.[MCP_SERVER_NAME];
    if (!borgServer || borgServer.type !== 'local') return undefined;
    const environment = borgServer.environment ?? borgServer.env;
    if (environment?.BORG_AGENT_KIND !== 'opencode' && environment?.BORG_OPENCODE !== '1') {
      return undefined;
    }
    return borgServer.command;
  } catch {
    return undefined;
  }
}

export interface RefreshManagedAgentMcpConfigOptions {
  claudeConfigPath?: string;
  codexConfigPath?: string;
  openCodeConfigPath?: string;
  refreshClaude?: () => void;
  refreshCodex?: () => void;
  refreshOpenCode?: () => void;
}

function refreshClaudeMcpCommand(configPath: string): void {
  const config = readJsonFile(configPath);
  config.mcpServers[MCP_SERVER_NAME].command = MCP_COMMAND;
  writeJsonFile(configPath, config);
}

function refreshCodexMcpCommand(configPath: string): void {
  const text = fs.readFileSync(configPath, 'utf-8');
  const header = /^\s*\[mcp_servers\.borg\]\s*$/m.exec(text);
  if (!header) return;
  const sectionStart = header.index + header[0].length;
  const tail = text.slice(sectionStart);
  const nextHeader = /^\s*\[/m.exec(tail);
  const sectionEnd = nextHeader ? sectionStart + nextHeader.index : text.length;
  const section = text.slice(sectionStart, sectionEnd);
  const updatedSection = section.replace(
    /^(\s*command\s*=\s*)"[^"]+"(\s*)$/m,
    `$1"${MCP_COMMAND}"$2`,
  );
  fs.writeFileSync(
    configPath,
    text.slice(0, sectionStart) + updatedSection + text.slice(sectionEnd),
    'utf-8',
  );
}

function refreshOpenCodeMcpCommand(configPath: string): void {
  const config = readJsonFile(configPath);
  const borgServer = config.mcp[MCP_SERVER_NAME];
  borgServer.command = Array.isArray(borgServer.command) ? [MCP_COMMAND] : MCP_COMMAND;
  writeJsonFile(configPath, config);
}

/**
 * Replace only the command in stale Borg registrations. Other entry fields are
 * preserved, and a `borg` entry that points at another command is not changed.
 */
export function refreshManagedAgentMcpConfigs(
  options: RefreshManagedAgentMcpConfigOptions = {},
): Array<'claude' | 'codex' | 'opencode'> {
  const refreshed: Array<'claude' | 'codex' | 'opencode'> = [];
  const failures: string[] = [];
  const claudeConfigPath = options.claudeConfigPath ?? CLAUDE_CONFIG_PATH;
  const codexConfigPath = options.codexConfigPath ?? CODEX_CONFIG_PATH;
  const openCodeConfigPath = options.openCodeConfigPath ?? OPENCODE_CONFIG_PATH;
  const agents = [
    {
      kind: 'claude' as const,
      label: 'Claude Code',
      command: readClaudeMcpCommand(claudeConfigPath),
      refresh: options.refreshClaude ?? (() => refreshClaudeMcpCommand(claudeConfigPath)),
    },
    {
      kind: 'codex' as const,
      label: 'Codex',
      command: readCodexMcpCommand(codexConfigPath),
      refresh: options.refreshCodex ?? (() => refreshCodexMcpCommand(codexConfigPath)),
    },
    {
      kind: 'opencode' as const,
      label: 'OpenCode',
      command: readOpenCodeMcpCommand(openCodeConfigPath),
      refresh: options.refreshOpenCode ?? (() => refreshOpenCodeMcpCommand(openCodeConfigPath)),
    },
  ];

  for (const agent of agents) {
    if (!isStaleBorgMcpCommand(agent.command)) continue;
    try {
      agent.refresh();
      refreshed.push(agent.kind);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${agent.label}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Could not refresh agent MCP configs: ${failures.join('; ')}`);
  }
  return refreshed;
}

/**
 * Get absolute path to borg index.js
 * Returns the actual index.js file, not the npm symlink
 */
export function getBinaryPath(): string {
  // In production: dist/index.js is in the same directory as this file
  // In development: same
  return path.join(__dirname, 'index.js');
}

/**
 * Add borg MCP server to Claude Code using claude CLI
 * First removes any existing borg configuration, then adds fresh one
 * Runs: claude mcp remove --scope user borg && claude mcp add --scope user borg borg-mcp
 */
export function addMcpServer(): void {
  try {
    const agentConfigEnv = borgAgentConfigEnv(process.env);
    // First, remove any existing borg configuration (ignore errors if not found)
    try {
      execSync('claude mcp remove --scope user borg', { stdio: 'ignore', env: agentConfigEnv });
    } catch {
      // Ignore - server might not exist yet
    }

    const command = `claude mcp add --scope user borg ${shellQuote(MCP_COMMAND)}`;

    execSync(command, {
      stdio: 'inherit', // Show output to user
      // No hosted-URL injection: BORG_API_URL passes through from the
      // environment only when the operator has explicitly set it.
      env: agentConfigEnv,
    });
  } catch (error: any) {
    if (error.message?.includes('command not found')) {
      throw new Error('Claude CLI not found. Please install Claude Code first.');
    }
    throw new Error(`Failed to add MCP server: ${error.message}`);
  }
}

export function addCodexMcpServer(): void {
  try {
    const codexConfigEnv = withAgentRuntimeEnv(borgAgentConfigEnv(process.env), 'codex');
    try {
      execSync('codex mcp remove borg', { stdio: 'ignore', env: codexConfigEnv });
    } catch {
      // Ignore - server might not exist yet.
    }

    // No hosted-URL fallback: only forward BORG_API_URL into the generated
    // Codex MCP config when the operator has explicitly set it.
    const apiUrl = process.env.BORG_API_URL;
    // Identity is durable configuration; remote wake is a per-launch
    // transport capability. Do not persist a transport marker here: a future
    // Codex child may launch without a live --remote socket.
    const apiUrlEnvArg = apiUrl ? ` --env BORG_API_URL=${shellQuote(apiUrl)}` : '';
    const stateRoot = process.env[BORG_STATE_ROOT_ENV];
    const stateRootEnvArg = stateRoot
      ? ` --env ${BORG_STATE_ROOT_ENV}=${shellQuote(stateRoot)}`
      : '';
    execSync('codex mcp add borg' +
      apiUrlEnvArg +
      stateRootEnvArg +
      ` --env ${BORG_AGENT_KIND_ENV}=codex` +
      ` -- ${shellQuote(MCP_COMMAND)}`, {
      stdio: 'inherit',
      env: codexConfigEnv,
    });
  } catch (error: any) {
    if (error.message?.includes('command not found')) {
      throw new Error('Codex CLI not found. Please install Codex first.');
    }
    throw new Error(`Failed to add MCP server to Codex: ${error.message}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function addCodexHook(
  eventName: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse',
  command: string,
  options: { matcher?: string; timeout?: number } = {},
  hooksPath: string = CODEX_HOOKS_PATH,
): boolean {
  let hooksFile: any;
  try {
    hooksFile = readJsonFile(hooksPath);
  } catch (err: any) {
    console.error(`⚠ Could not parse ${hooksPath}: ${err.message}. Skipping Codex hook registration.`);
    return false;
  }

  hooksFile.hooks ??= {};
  hooksFile.hooks[eventName] ??= [];
  const entries = hooksFile.hooks[eventName];
  if (!Array.isArray(entries)) return false;

  // gh#client#18: migrate owned hooks to canonical form and deduplicate
  // (exactly one canonical hook per owned command, preserving unrelated
  // siblings and entry metadata).
  let changed = migrateAndDedupOwnedHooks(entries);

  if (!hasCanonicalCommandHook(entries, command)) {
    const entry: any = {
      hooks: [{ type: 'command', command }],
    };
    if (options.matcher) entry.matcher = options.matcher;
    if (typeof options.timeout === 'number') entry.hooks[0].timeout = options.timeout;
    entries.push(entry);
    changed = true;
  }
  if (changed) writeJsonFile(hooksPath, hooksFile);
  return changed;
}

export function addCodexSessionStartHook(): boolean {
  return addCodexHook('SessionStart', HOOK_COMMAND, { matcher: 'startup|resume', timeout: 30 });
}

export function addCodexUserPromptSubmitHook(): boolean {
  return addCodexHook('UserPromptSubmit', AUDIT_HOOK_COMMAND, { timeout: 10 });
}

/** Register the advisory foreign-path reminder on Codex's native hook surface. */
export function addCodexForeignPathReminderHook(hooksPath: string = CODEX_HOOKS_PATH): boolean {
  return addCodexHook('PreToolUse', FOREIGN_PATH_REMINDER_HOOK_COMMAND, {}, hooksPath);
}

export function isCodexHookRegistered(
  eventName: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Stop',
  command: string,
  hooksPath: string = CODEX_HOOKS_PATH
): boolean {
  try {
    const parsed = readJsonFile(hooksPath);
    const arr = parsed?.hooks?.[eventName];
    if (!Array.isArray(arr)) return false;
    return arr.some((entry: any) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h: any) => {
        if (h?.type !== 'command' || typeof h?.command !== 'string') return false;
        if (command === HOOK_COMMAND) return isCanonicalCommand(h.command, command);
        if (command === AUDIT_HOOK_COMMAND) return isCanonicalCommand(h.command, command);
        return h.command === command;
      })
    );
  } catch {
    return false;
  }
}

/**
 * Peek: true iff the Codex SessionStart orientation hook (`borg-regen`) is
 * registered. Non-mutating mirror of addCodexSessionStartHook; used to gate
 * that writer + the gh#844 disclosure on whether it would actually mutate.
 */
export function isCodexSessionStartHookRegistered(hooksPath: string = CODEX_HOOKS_PATH): boolean {
  return isCodexHookRegistered('SessionStart', HOOK_COMMAND, hooksPath);
}

/**
 * Peek: true iff the Codex UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addCodexUserPromptSubmitHook.
 */
export function isCodexUserPromptSubmitHookRegistered(hooksPath: string = CODEX_HOOKS_PATH): boolean {
  return isCodexHookRegistered('UserPromptSubmit', AUDIT_HOOK_COMMAND, hooksPath);
}

// ─── OpenCode MCP integration ────────────────────────────────────────────

/**
 * Detect whether the borg MCP server is registered in OpenCode's effective
 * global config. OpenCode 1.18.15 loads `config.json`, `opencode.json`, then
 * `opencode.jsonc`, merging later files over earlier ones.
 *
 * Reads JSON or JSONC and checks the effective `mcp.borg` entry for
 * `type: "local"`. Safe-default: any read error returns `false`.
 */
export function isOpenCodeMcpServerConfigured(
  configPath: string = path.join(borgHomeRoot(), '.config', 'opencode', 'opencode.json')
): boolean {
  try {
    const borgServer = (readOpenCodeGlobalConfig(configPath) as any).mcp?.borg;
    if (!borgServer || typeof borgServer !== 'object') return false;
    return borgServer.type === 'local';
  } catch {
    return false;
  }
}

/**
 * Launch-time OpenCode registration check. Every launch requires the exact
 * password substitution that carries its ephemeral credential into OpenCode's
 * MCP child. A targeted `borg launch`, identified by its non-empty expected-seat
 * marker, additionally requires the substitution that carries that marker.
 */
export function isOpenCodeMcpServerConfiguredForLaunch(
  configPath: string = path.join(borgHomeRoot(), '.config', 'opencode', 'opencode.json'),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isOpenCodeMcpServerConfigured(configPath)) return false;
  try {
    const borgServer = (readOpenCodeGlobalConfig(configPath) as any).mcp?.borg;
    const environment = borgServer?.environment ?? borgServer?.env;
    if (environment?.[OPENCODE_SERVER_PASSWORD_ENV] !== OPENCODE_SERVER_PASSWORD_REFERENCE) {
      return false;
    }
    if (!env[BORG_LAUNCH_EXPECTED_SEAT_ENV]) return true;
    return environment?.[BORG_LAUNCH_EXPECTED_SEAT_ENV] === OPENCODE_LAUNCH_EXPECTED_SEAT_REFERENCE;
  } catch {
    return false;
  }
}

/**
 * Pre-authorize the exact worktree + scratch paths in the launch-root
 * OpenCode config. This intentionally writes only the project-local
 * `.opencode/opencode.json`; the user-global config is shared by every seat.
 */
export function addOpenCodeLaunchAccess(
  projectRoot: string,
  paths: LaunchAccessPaths,
): boolean {
  const configPath = path.join(projectRoot, '.opencode', 'opencode.json');
  let config: any;
  try {
    config = readJsonFile(configPath);
  } catch (err: any) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`OpenCode config ${configPath} is not an object`);
  }

  const before = JSON.stringify(config);
  const permission = config.permission;
  let permissionObject: Record<string, unknown>;
  if (permission === undefined) {
    permissionObject = {};
  } else if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
    permissionObject = { '*': permission };
  } else if (permission && typeof permission === 'object' && !Array.isArray(permission)) {
    permissionObject = { ...(permission as Record<string, unknown>) };
  } else {
    throw new Error(`OpenCode permission in ${configPath} has an unsupported shape`);
  }

  const existingExternal = permissionObject.external_directory;
  let external: Record<string, unknown>;
  if (existingExternal === undefined) {
    external = {};
  } else if (existingExternal === 'allow' || existingExternal === 'ask' || existingExternal === 'deny') {
    external = { '*': existingExternal };
  } else if (existingExternal && typeof existingExternal === 'object' && !Array.isArray(existingExternal)) {
    external = { ...(existingExternal as Record<string, unknown>) };
  } else {
    throw new Error(`OpenCode permission.external_directory in ${configPath} has an unsupported shape`);
  }

  for (const directory of [paths.worktree, paths.scratch].map((value) => path.resolve(value))) {
    // OpenCode matches external_directory patterns against the requested path,
    // so a literal directory key does not authorize files below that directory.
    // The exact `allow` shape is the literal form written by the predecessor;
    // migrate only that owned key. Never replace an existing subtree decision
    // or exact decision supplied by the operator.
    const subtree = `${directory}/**`;
    const hasExact = Object.prototype.hasOwnProperty.call(external, directory);
    const hasSubtree = Object.prototype.hasOwnProperty.call(external, subtree);
    if (external[directory] === 'allow') {
      delete external[directory];
      if (!hasSubtree) external[subtree] = 'allow';
    } else if (!hasExact && !hasSubtree) {
      external[subtree] = 'allow';
    }
  }
  permissionObject.external_directory = external;
  config.permission = permissionObject;

  const changed = JSON.stringify(config) !== before;
  if (changed) writeJsonFile(configPath, config);
  return changed;
}

/**
 * Add borg MCP server to OpenCode using `opencode mcp add` CLI.
 * Pins activation and agent-kind signals plus OpenCode config substitutions
 * for the launch-scoped password and expected seat. OpenCode resolves
 * `{env:NAME}` from its own launch environment before starting the MCP child,
 * so no launch credential is persisted. Existing configs with BORG_OPENCODE
 * remain supported by the runtime fallback after launch-time self-healing.
 */
export function addOpenCodeMcpServer(): void {
  try {
    // No hosted-URL fallback: only forward BORG_API_URL when explicitly set.
    const apiUrl = process.env.BORG_API_URL;
    const apiUrlEnvArg = apiUrl ? ` --env BORG_API_URL=${shellQuote(apiUrl)}` : '';
    const stateRoot = process.env[BORG_STATE_ROOT_ENV];
    const stateRootEnvArg = stateRoot
      ? ` --env ${BORG_STATE_ROOT_ENV}=${shellQuote(stateRoot)}`
      : '';
    const launchExpectedSeatEnvArg =
      ` --env ${BORG_LAUNCH_EXPECTED_SEAT_ENV}=${shellQuote(OPENCODE_LAUNCH_EXPECTED_SEAT_REFERENCE)}`;
    const apiPasswordEnvArg =
      ` --env ${OPENCODE_SERVER_PASSWORD_ENV}=${shellQuote(OPENCODE_SERVER_PASSWORD_REFERENCE)}`;
    execSync(
      `opencode mcp add borg --env BORG_SESSION=1 --env BORG_AGENT_KIND=opencode --env BORG_OPENCODE=1${apiUrlEnvArg}${stateRootEnvArg}${launchExpectedSeatEnvArg}${apiPasswordEnvArg} -- ${shellQuote(MCP_COMMAND)}`,
      { stdio: 'inherit', env: borgAgentConfigEnv(process.env) }
    );
  } catch (error: any) {
    if (error.message?.includes('command not found')) {
      throw new Error('opencode CLI not found. Please install opencode first.');
    }
    throw new Error(`Failed to add MCP server to opencode: ${error.message}`);
  }
}
