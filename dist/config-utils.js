/**
 * MCP Settings Configuration Utilities
 *
 * Handles adding borg-mcp to Claude Code via the claude CLI
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { BORG_AGENT_KIND_ENV, BORG_CODEX_REMOTE_WAKE_ENV, withAgentRuntimeEnv, } from './agent-runtime.js';
import { resolveMcpBinaryPath, resolveRegenPath, resolveClearRewakePath, resolveLogAuditPath, } from './self-path.js';
import { shellEscape } from './shell-escape.js';
// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// gh#client#18: canonical hook commands stored in JSON are shell-escaped
// absolute paths. Bare names and stale/other-install absolute paths are
// migrated to this form on every hook write.
const HOOK_COMMAND = shellEscape(resolveRegenPath());
const CLEAR_REWAKE_HOOK_COMMAND = shellEscape(resolveClearRewakePath());
const AUDIT_HOOK_COMMAND = shellEscape(resolveLogAuditPath());
const MCP_BINARY = resolveMcpBinaryPath();
/**
 * Claude Code CLI config path. The CLI reads `mcpServers.<name>` from
 * this file to discover registered MCP servers; `addMcpServer()` (below)
 * writes to it via the `claude mcp add --scope user borg borg-mcp` shell
 * command. Server name is `borg` (not `borgmcp` — `borg-mcp` is the
 * binary that backs it). NOTE: distinct from
 * `~/Library/Application Support/Claude/claude_desktop_config.json`,
 * which is the Claude Desktop app's config (different product).
 */
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');
const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const MCP_SERVER_NAME = 'borg';
function settingsPath() {
    return path.join(os.homedir(), '.claude', 'settings.json');
}
function readSettings() {
    const p = settingsPath();
    if (!fs.existsSync(p))
        return {};
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim())
        return {};
    return JSON.parse(text);
}
function writeSettings(settings) {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
function readJsonFile(p) {
    if (!fs.existsSync(p))
        return {};
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim())
        return {};
    return JSON.parse(text);
}
function writeJsonFile(p, data) {
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
export function addSessionStartHook() {
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
export function addProjectSessionStartHook(projectRoot) {
    return addSessionStartHookAt(projectSettingsPath(projectRoot), true);
}
/** Peek variant of addProjectSessionStartHook — no mutation. */
export function isProjectSessionStartHookRegistered(projectRoot) {
    return sessionStartHookRegisteredAt(projectSettingsPath(projectRoot), true);
}
function projectSettingsPath(projectRoot) {
    return path.join(projectRoot, '.claude', 'settings.local.json');
}
function addSessionStartHookAt(settingsFile, includeClearRewake = false) {
    let settings;
    try {
        settings = readJsonFile(settingsFile);
    }
    catch (err) {
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
    if (!changed)
        return false;
    writeJsonFile(settingsFile, settings);
    return true;
}
// gh#client#18: match bare names (old configs), stale absolute paths (other
// installations), shell-escaped canonical paths, and unescaped canonical paths.
function commandMatches(entryCommand, bareName, absolutePath) {
    const escaped = shellEscape(absolutePath);
    if (entryCommand === escaped || entryCommand === absolutePath || entryCommand === bareName)
        return true;
    // gh#client#18: stale prior-install absolute paths (e.g.
    // /old/.../dist/regen.js) end with the same basename. Only match
    // when the command IS an absolute path ending with the bare name to
    // avoid false positives on unrelated commands like "run regen.js".
    if (entryCommand.startsWith('/') && entryCommand.endsWith(`/${bareName}`))
        return true;
    return false;
}
/** gh#client#18: map an owned hook command to its canonical shell-escaped form.
 *  Returns null for non-owned commands. Ownership requires EXACTLY ONE of:
 *  (a) Exact bare bin name (borg-regen, borg-clear-rewake, borg-log-audit)
 *  (b) Exact match (raw or shell-escaped) of THIS installation's canonical
 *      absolute command — always owned, no marker required (fixes neutral-path
 *      false negatives that broke idempotency)
 *  (c) Foreign-install heuristic: absolute path ending in an owned basename
 *      AND containing a borg package marker (borgmcp|borg-mcp) in the path
 *  This prevents false-positive ownership of unrelated scripts that happen
 *  to share a basename (e.g. /opt/custom-tool/regen.js). */
function ownedCanonical(command) {
    const stripped = command.replace(/^'|'$/g, '');
    // (a) Exact bare name — always owned
    if (stripped === BARE_BORG_REGEN)
        return HOOK_COMMAND;
    if (stripped === BARE_CLEAR_REWAKE)
        return CLEAR_REWAKE_HOOK_COMMAND;
    if (stripped === BARE_LOG_AUDIT)
        return AUDIT_HOOK_COMMAND;
    // (b) Exact match of THIS installation's canonical command (raw or escaped)
    // — always owned, no marker check required
    if (command === HOOK_COMMAND || stripped === resolveRegenPath())
        return HOOK_COMMAND;
    if (command === CLEAR_REWAKE_HOOK_COMMAND || stripped === resolveClearRewakePath())
        return CLEAR_REWAKE_HOOK_COMMAND;
    if (command === AUDIT_HOOK_COMMAND || stripped === resolveLogAuditPath())
        return AUDIT_HOOK_COMMAND;
    // (c) Foreign-install heuristic: absolute path + owned basename + borg marker
    if (stripped.startsWith('/') && (stripped.includes('borgmcp') || stripped.includes('borg-mcp'))) {
        const name = stripped.split('/').pop() ?? '';
        if (name === 'regen.js')
            return HOOK_COMMAND;
        if (name === 'clear-rewake.js')
            return CLEAR_REWAKE_HOOK_COMMAND;
        if (name === 'log-audit.js')
            return AUDIT_HOOK_COMMAND;
    }
    return null;
}
/**
 * gh#client#18: migrate owned hooks to canonical form and deduplicate:
 * exactly one canonical hook per owned command. Removes only duplicate owned
 * hook objects within entries, preserving unrelated siblings and entry metadata.
 * Mutates the entries array in place. Returns true if any change was made.
 */
function migrateAndDedupOwnedHooks(entries) {
    let changed = false;
    // Phase 1: Migrate owned hooks to canonical form
    for (const entry of entries) {
        if (!Array.isArray(entry?.hooks))
            continue;
        for (const hook of entry.hooks) {
            if (hook?.type !== 'command' || typeof hook?.command !== 'string')
                continue;
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
    const seenCanonicals = new Set();
    for (const entry of entries) {
        if (!Array.isArray(entry?.hooks))
            continue;
        const before = entry.hooks.length;
        entry.hooks = entry.hooks.filter((hook) => {
            if (hook?.type !== 'command' || typeof hook?.command !== 'string')
                return true;
            const canonical = ownedCanonical(hook.command);
            if (!canonical)
                return true;
            if (seenCanonicals.has(canonical)) {
                changed = true;
                return false;
            }
            seenCanonicals.add(canonical);
            return true;
        });
        if (entry.hooks.length !== before)
            changed = true;
    }
    // Phase 3: Remove entries that became empty after dedup
    for (let i = entries.length - 1; i >= 0; i--) {
        if (!Array.isArray(entries[i]?.hooks) || entries[i].hooks.length === 0) {
            entries.splice(i, 1);
            changed = true;
        }
    }
    return changed;
}
/** Strict canonical match: only the shell-escaped canonical form.
 *  gh#client#18: raw unescaped paths are NOT canonical — a path with spaces
 *  or metacharacters would break at shell-fire time if not escaped. */
function isCanonicalCommand(entryCommand, canonical) {
    return entryCommand === canonical;
}
const BARE_BORG_REGEN = 'borg-regen';
const BARE_CLEAR_REWAKE = 'borg-clear-rewake';
const BARE_LOG_AUDIT = 'borg-log-audit';
function hasCommandHook(entries, command) {
    return entries.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            // gh#client#18: for known owned commands, check if this hook's command
            // maps to the SAME canonical as the target. This correctly distinguishes
            // regen from clear-rewake from audit — a clear-rewake hook does NOT
            // satisfy the dedup check for a regen target, and vice versa.
            if (command === HOOK_COMMAND || command === CLEAR_REWAKE_HOOK_COMMAND || command === AUDIT_HOOK_COMMAND) {
                return ownedCanonical(h.command) === command;
            }
            return h.command === command;
        }));
}
/** Strict: only the shell-escaped canonical form (no bare-name fallback). */
function hasCanonicalCommandHook(entries, command) {
    return entries.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            return isCanonicalCommand(h.command, command);
        }));
}
function isClearRewakeCommand(hook) {
    if (hook?.type !== 'command' || typeof hook?.command !== 'string')
        return false;
    return commandMatches(hook.command, BARE_CLEAR_REWAKE, resolveClearRewakePath());
}
function isCanonicalClearRewakeEntry(entry) {
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
function normalizeClearRewakeHook(entries) {
    let migrated = false;
    const result = entries.map((entry) => {
        if (!Array.isArray(entry?.hooks))
            return entry;
        const hooks = entry.hooks.map((hook) => {
            if (isClearRewakeCommand(hook) && !isCanonicalCommand(hook.command, CLEAR_REWAKE_HOOK_COMMAND)) {
                migrated = true;
                return { ...hook, command: CLEAR_REWAKE_HOOK_COMMAND };
            }
            return hook;
        });
        return hooks === entry.hooks ? entry : { ...entry, hooks };
    });
    const commandCount = result.reduce((count, entry) => count + (Array.isArray(entry?.hooks) ? entry.hooks.filter(isClearRewakeCommand).length : 0), 0);
    if (commandCount === 1 && result.some(isCanonicalClearRewakeEntry)) {
        return migrated ? result : null;
    }
    const withoutOwnedCommand = result.flatMap((entry) => {
        if (!Array.isArray(entry?.hooks))
            return [entry];
        const hooks = entry.hooks.filter((hook) => !isClearRewakeCommand(hook));
        return hooks.length > 0 ? [{ ...entry, hooks }] : [];
    });
    withoutOwnedCommand.push({
        matcher: 'clear',
        hooks: [{ type: 'command', command: CLEAR_REWAKE_HOOK_COMMAND, asyncRewake: true }],
    });
    return withoutOwnedCommand;
}
function sessionStartHookRegisteredAt(settingsFile, includeClearRewake = false) {
    let settings;
    try {
        settings = readJsonFile(settingsFile);
    }
    catch {
        return false;
    }
    const arr = settings?.hooks?.SessionStart;
    if (!Array.isArray(arr))
        return false;
    return hasCanonicalCommandHook(arr, HOOK_COMMAND) &&
        (!includeClearRewake || normalizeClearRewakeHook(arr) === null);
}
/**
 * Peek whether the borg-regen SessionStart hook is already registered, without
 * mutating settings. Returns false on any read error (safe-default).
 */
export function isSessionStartHookRegistered() {
    let settings;
    try {
        settings = readSettings();
    }
    catch {
        return false;
    }
    const arr = settings?.hooks?.SessionStart;
    if (!Array.isArray(arr))
        return false;
    return arr.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            return isCanonicalCommand(h.command, HOOK_COMMAND);
        }));
}
/**
 * Peek: true iff the Claude UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addUserPromptSubmitHook's idempotency
 * check; used by isClaudeHookConfigPending (gh#844).
 */
export function isUserPromptSubmitHookRegistered() {
    let settings;
    try {
        settings = readSettings();
    }
    catch {
        return false;
    }
    const arr = settings?.hooks?.UserPromptSubmit;
    if (!Array.isArray(arr))
        return false;
    return arr.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            return isCanonicalCommand(h.command, AUDIT_HOOK_COMMAND);
        }));
}
/**
 * Inverse of addSessionStartHook: remove any SessionStart hook entry whose
 * inner hooks array contains a `borg-regen` command. If multiple commands
 * share an entry, only the borg-regen command is removed; otherwise the
 * entire entry is dropped. Empty containers are cleaned up.
 *
 * Returns true if a change was made, false otherwise.
 */
export function removeSessionStartHook() {
    let settings;
    try {
        settings = readSettings();
    }
    catch {
        return false;
    }
    if (!settings?.hooks?.SessionStart)
        return false;
    let changed = false;
    settings.hooks.SessionStart = settings.hooks.SessionStart
        .map((entry) => {
        if (!Array.isArray(entry?.hooks))
            return entry;
        const filtered = entry.hooks.filter((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return true;
            return !commandMatches(h.command, BARE_BORG_REGEN, HOOK_COMMAND);
        });
        if (filtered.length !== entry.hooks.length) {
            changed = true;
            return { ...entry, hooks: filtered };
        }
        return entry;
    })
        .filter((entry) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);
    if (settings.hooks.SessionStart.length === 0) {
        delete settings.hooks.SessionStart;
    }
    if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
    }
    if (changed)
        writeSettings(settings);
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
export function addUserPromptSubmitHook() {
    let settings;
    try {
        settings = readSettings();
    }
    catch (err) {
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
    if (changed)
        writeSettings(settings);
    return changed;
}
/**
 * Inverse of addUserPromptSubmitHook: remove any UserPromptSubmit hook
 * entry that runs `borg-log-audit`. Symmetric cleanup to
 * removeSessionStartHook.
 */
export function removeUserPromptSubmitHook() {
    let settings;
    try {
        settings = readSettings();
    }
    catch {
        return false;
    }
    if (!settings?.hooks?.UserPromptSubmit)
        return false;
    let changed = false;
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
        .map((entry) => {
        if (!Array.isArray(entry?.hooks))
            return entry;
        const filtered = entry.hooks.filter((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return true;
            return !commandMatches(h.command, BARE_LOG_AUDIT, AUDIT_HOOK_COMMAND);
        });
        if (filtered.length !== entry.hooks.length) {
            changed = true;
            return { ...entry, hooks: filtered };
        }
        return entry;
    })
        .filter((entry) => Array.isArray(entry?.hooks) && entry.hooks.length > 0);
    if (settings.hooks.UserPromptSubmit.length === 0) {
        delete settings.hooks.UserPromptSubmit;
    }
    if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
    }
    if (changed)
        writeSettings(settings);
    return changed;
}
/**
 * Detect whether the borg MCP server is already registered in the Claude
 * Code CLI config (`~/.claude.json` `mcpServers.borg`).
 *
 * Per gh#79: when a user re-runs `borg setup` to refresh OAuth (the
 * canonical re-run reason), the setup wizard's "Add borg to Claude Code?"
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
export function isMcpServerConfigured(configPath = CLAUDE_CONFIG_PATH) {
    try {
        if (!fs.existsSync(configPath))
            return false;
        const text = fs.readFileSync(configPath, 'utf-8');
        if (!text.trim())
            return false;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object')
            return false;
        const servers = parsed.mcpServers;
        if (!servers || typeof servers !== 'object' || Array.isArray(servers))
            return false;
        return MCP_SERVER_NAME in servers;
    }
    catch {
        return false;
    }
}
export function isCodexMcpServerConfigured(configPath = CODEX_CONFIG_PATH) {
    try {
        if (!fs.existsSync(configPath))
            return false;
        const text = fs.readFileSync(configPath, 'utf-8');
        const hasBorgServer = /^\s*\[mcp_servers\.borg\]\s*$/m.test(text);
        const hasPinnedCodexIdentity = new RegExp(`^\\s*${BORG_AGENT_KIND_ENV}\\s*=\\s*"codex"\\s*$`, 'm').test(text);
        // gh#968 compatibility: older installations encoded the Codex CLI
        // identity using the remote-wake transport marker. Keep recognizing that
        // static shape so setup does not overwrite a working legacy config merely
        // to migrate its marker.
        const hasLegacyRemoteWakeIdentity = new RegExp(`^\\s*${BORG_CODEX_REMOTE_WAKE_ENV}\\s*=\\s*"1"\\s*$`, 'm').test(text);
        return hasBorgServer && (hasPinnedCodexIdentity || hasLegacyRemoteWakeIdentity);
    }
    catch {
        return false;
    }
}
/**
 * Get absolute path to borg index.js
 * Returns the actual index.js file, not the npm symlink
 */
export function getBinaryPath() {
    // In production: dist/index.js is in the same directory as this file
    // In development: same
    return path.join(__dirname, 'index.js');
}
/**
 * Add borg MCP server to Claude Code using claude CLI
 * First removes any existing borg configuration, then adds fresh one
 * Runs: claude mcp remove --scope user borg && claude mcp add --scope user borg borg-mcp
 */
export function addMcpServer() {
    try {
        // First, remove any existing borg configuration (ignore errors if not found)
        try {
            execSync('claude mcp remove --scope user borg', { stdio: 'ignore' });
        }
        catch {
            // Ignore - server might not exist yet
        }
        // gh#client#18: use absolute path to THIS installation's binary so the
        // registered server always matches the running client version.
        const command = `claude mcp add --scope user borg ${shellQuote(MCP_BINARY)}`;
        execSync(command, {
            stdio: 'inherit', // Show output to user
            // No hosted-URL injection: BORG_API_URL passes through from the
            // environment only when the operator has explicitly set it.
            env: process.env,
        });
    }
    catch (error) {
        if (error.message?.includes('command not found')) {
            throw new Error('Claude CLI not found. Please install Claude Code first.');
        }
        throw new Error(`Failed to add MCP server: ${error.message}`);
    }
}
export function addCodexMcpServer() {
    try {
        try {
            execSync('codex mcp remove borg', { stdio: 'ignore' });
        }
        catch {
            // Ignore - server might not exist yet.
        }
        // No hosted-URL fallback: only forward BORG_API_URL into the generated
        // Codex MCP config when the operator has explicitly set it.
        const apiUrl = process.env.BORG_API_URL;
        // Identity is durable configuration; remote wake is a per-launch
        // transport capability. Do not persist a transport marker here: a future
        // Codex child may launch without a live --remote socket.
        // gh#client#18: use absolute path to THIS installation's binary.
        const codexConfigEnv = withAgentRuntimeEnv(process.env, 'codex');
        const apiUrlEnvArg = apiUrl ? ` --env BORG_API_URL=${shellQuote(apiUrl)}` : '';
        execSync('codex mcp add borg' +
            apiUrlEnvArg +
            ` --env ${BORG_AGENT_KIND_ENV}=codex` +
            ` -- ${shellQuote(MCP_BINARY)}`, {
            stdio: 'inherit',
            env: codexConfigEnv,
        });
    }
    catch (error) {
        if (error.message?.includes('command not found')) {
            throw new Error('Codex CLI not found. Please install Codex first.');
        }
        throw new Error(`Failed to add MCP server to Codex: ${error.message}`);
    }
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function addCodexHook(eventName, command, options = {}) {
    let hooksFile;
    try {
        hooksFile = readJsonFile(CODEX_HOOKS_PATH);
    }
    catch (err) {
        console.error(`⚠ Could not parse ${CODEX_HOOKS_PATH}: ${err.message}. Skipping Codex hook registration.`);
        return false;
    }
    hooksFile.hooks ??= {};
    hooksFile.hooks[eventName] ??= [];
    const entries = hooksFile.hooks[eventName];
    if (!Array.isArray(entries))
        return false;
    // gh#client#18: migrate owned hooks to canonical form and deduplicate
    // (exactly one canonical hook per owned command, preserving unrelated
    // siblings and entry metadata).
    let changed = migrateAndDedupOwnedHooks(entries);
    if (!hasCanonicalCommandHook(entries, command)) {
        const entry = {
            hooks: [{ type: 'command', command }],
        };
        if (options.matcher)
            entry.matcher = options.matcher;
        if (typeof options.timeout === 'number')
            entry.hooks[0].timeout = options.timeout;
        entries.push(entry);
        changed = true;
    }
    if (changed)
        writeJsonFile(CODEX_HOOKS_PATH, hooksFile);
    return changed;
}
export function addCodexSessionStartHook() {
    return addCodexHook('SessionStart', HOOK_COMMAND, { matcher: 'startup|resume', timeout: 30 });
}
export function addCodexUserPromptSubmitHook() {
    return addCodexHook('UserPromptSubmit', AUDIT_HOOK_COMMAND, { timeout: 10 });
}
export function isCodexHookRegistered(eventName, command, hooksPath = CODEX_HOOKS_PATH) {
    try {
        const parsed = readJsonFile(hooksPath);
        const arr = parsed?.hooks?.[eventName];
        if (!Array.isArray(arr))
            return false;
        return arr.some((entry) => Array.isArray(entry?.hooks) &&
            entry.hooks.some((h) => {
                if (h?.type !== 'command' || typeof h?.command !== 'string')
                    return false;
                if (command === HOOK_COMMAND)
                    return isCanonicalCommand(h.command, command);
                if (command === AUDIT_HOOK_COMMAND)
                    return isCanonicalCommand(h.command, command);
                return h.command === command;
            }));
    }
    catch {
        return false;
    }
}
/**
 * Peek: true iff the Codex SessionStart orientation hook (`borg-regen`) is
 * registered. Non-mutating mirror of addCodexSessionStartHook; used to gate
 * that writer + the gh#844 disclosure on whether it would actually mutate.
 */
export function isCodexSessionStartHookRegistered(hooksPath = CODEX_HOOKS_PATH) {
    return isCodexHookRegistered('SessionStart', HOOK_COMMAND, hooksPath);
}
/**
 * Peek: true iff the Codex UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addCodexUserPromptSubmitHook.
 */
export function isCodexUserPromptSubmitHookRegistered(hooksPath = CODEX_HOOKS_PATH) {
    return isCodexHookRegistered('UserPromptSubmit', AUDIT_HOOK_COMMAND, hooksPath);
}
// ─── OpenCode MCP integration ────────────────────────────────────────────
/**
 * Detect whether the borg MCP server is already registered in the opencode
 * config (`~/.config/opencode/opencode.json` `mcp.borg`).
 *
 * Reads the config as JSON and checks for a `mcp.borg` entry with
 * `type: "local"`. Safe-default: any read error returns `false`.
 */
export function isOpenCodeMcpServerConfigured(configPath = OPENCODE_CONFIG_PATH) {
    try {
        if (!fs.existsSync(configPath))
            return false;
        const text = fs.readFileSync(configPath, 'utf-8');
        if (!text.trim())
            return false;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object')
            return false;
        const borgServer = parsed.mcp?.borg;
        if (!borgServer || typeof borgServer !== 'object')
            return false;
        return borgServer.type === 'local';
    }
    catch {
        return false;
    }
}
/**
 * Add borg MCP server to OpenCode using `opencode mcp add` CLI.
 * Pins BORG_SESSION=1, BORG_AGENT_KIND=opencode, the legacy BORG_OPENCODE=1,
 * and BORG_API_URL in the server environment so the MCP child inherits the
 * activation gate + explicit agent-kind signal (same approach as Codex's
 * pinned env — OpenCode MCP children only see pinned env, not parent process
 * env). Existing configs with BORG_OPENCODE remain supported by the runtime
 * fallback.
 */
export function addOpenCodeMcpServer() {
    try {
        // No hosted-URL fallback: only forward BORG_API_URL when explicitly set.
        const apiUrl = process.env.BORG_API_URL;
        const apiUrlEnvArg = apiUrl ? ` --env BORG_API_URL=${shellQuote(apiUrl)}` : '';
        // gh#client#18: use absolute path to THIS installation's binary.
        execSync(`opencode mcp add borg --env BORG_SESSION=1 --env BORG_AGENT_KIND=opencode --env BORG_OPENCODE=1${apiUrlEnvArg} -- ${shellQuote(MCP_BINARY)}`, { stdio: 'inherit' });
    }
    catch (error) {
        if (error.message?.includes('command not found')) {
            throw new Error('opencode CLI not found. Please install opencode first.');
        }
        throw new Error(`Failed to add MCP server to opencode: ${error.message}`);
    }
}
//# sourceMappingURL=config-utils.js.map