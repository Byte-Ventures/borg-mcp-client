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
// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// gh#client#18: resolve absolute paths from the running entrypoint so MCP
// config and hook registrations always point to THIS installation — never
// a bare PATH-resolved name that may resolve to a different version.
const HOOK_COMMAND = resolveRegenPath();
const CLEAR_REWAKE_HOOK_COMMAND = resolveClearRewakePath();
const AUDIT_HOOK_COMMAND = resolveLogAuditPath();
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
// gh#client#18: match both bare names (old configs) and absolute paths (new).
// When a bare name is a suffix of the absolute path, we also match via
// endsWith so a `node_modules/.bin/borg-regen` symlink path is recognized.
function commandMatches(entryCommand, bareName, absolutePath) {
    return entryCommand === absolutePath
        || entryCommand === bareName
        || entryCommand.endsWith(`/${bareName}`);
}
const BARE_BORG_REGEN = 'borg-regen';
const BARE_CLEAR_REWAKE = 'borg-clear-rewake';
const BARE_LOG_AUDIT = 'borg-log-audit';
function hasCommandHook(entries, command) {
    return entries.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            if (command === HOOK_COMMAND)
                return commandMatches(h.command, BARE_BORG_REGEN, command);
            if (command === CLEAR_REWAKE_HOOK_COMMAND)
                return commandMatches(h.command, BARE_CLEAR_REWAKE, command);
            if (command === AUDIT_HOOK_COMMAND)
                return commandMatches(h.command, BARE_LOG_AUDIT, command);
            return h.command === command;
        }));
}
function isClearRewakeCommand(hook) {
    if (hook?.type !== 'command' || typeof hook?.command !== 'string')
        return false;
    return commandMatches(hook.command, BARE_CLEAR_REWAKE, CLEAR_REWAKE_HOOK_COMMAND);
}
function isCanonicalClearRewakeEntry(entry) {
    return entry?.matcher === 'clear' &&
        Array.isArray(entry?.hooks) &&
        entry.hooks.length === 1 &&
        isClearRewakeCommand(entry.hooks[0]) &&
        entry.hooks[0].asyncRewake === true;
}
/**
 * Ensure one dedicated clear-only async-rewake handler. If a user has a
 * malformed or duplicate entry for our command, remove only that owned
 * command, preserve any unrelated sibling hooks, and append the canonical
 * entry once.
 */
function normalizeClearRewakeHook(entries) {
    const commandCount = entries.reduce((count, entry) => count + (Array.isArray(entry?.hooks) ? entry.hooks.filter(isClearRewakeCommand).length : 0), 0);
    if (commandCount === 1 && entries.some(isCanonicalClearRewakeEntry))
        return null;
    const withoutOwnedCommand = entries.flatMap((entry) => {
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
    return hasCommandHook(arr, HOOK_COMMAND) &&
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
            return commandMatches(h.command, BARE_BORG_REGEN, HOOK_COMMAND);
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
            return commandMatches(h.command, BARE_LOG_AUDIT, AUDIT_HOOK_COMMAND);
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
    const alreadyPresent = settings.hooks.UserPromptSubmit.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => h?.type === 'command' && h?.command === AUDIT_HOOK_COMMAND));
    if (alreadyPresent)
        return false;
    settings.hooks.UserPromptSubmit.push({
        matcher: '*',
        hooks: [{ type: 'command', command: AUDIT_HOOK_COMMAND }],
    });
    writeSettings(settings);
    return true;
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
            env: {
                ...process.env,
                BORG_API_URL: process.env.BORG_API_URL || 'https://api.borgmcp.ai'
            }
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
        const apiUrl = process.env.BORG_API_URL || 'https://api.borgmcp.ai';
        // Identity is durable configuration; remote wake is a per-launch
        // transport capability. Do not persist a transport marker here: a future
        // Codex child may launch without a live --remote socket.
        // gh#client#18: use absolute path to THIS installation's binary.
        const codexConfigEnv = withAgentRuntimeEnv(process.env, 'codex');
        execSync('codex mcp add borg --env BORG_API_URL=' +
            shellQuote(apiUrl) +
            ` --env ${BORG_AGENT_KIND_ENV}=codex` +
            ` -- ${shellQuote(MCP_BINARY)}`, {
            stdio: 'inherit',
            env: {
                ...codexConfigEnv,
                BORG_API_URL: apiUrl,
            },
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
    // gh#client#18: detect both bare names (old configs) and absolute paths (new).
    const alreadyPresent = entries.some((entry) => Array.isArray(entry?.hooks) &&
        entry.hooks.some((h) => {
            if (h?.type !== 'command' || typeof h?.command !== 'string')
                return false;
            if (command === HOOK_COMMAND)
                return commandMatches(h.command, BARE_BORG_REGEN, command);
            if (command === AUDIT_HOOK_COMMAND)
                return commandMatches(h.command, BARE_LOG_AUDIT, command);
            return h.command === command;
        }));
    if (alreadyPresent)
        return false;
    const entry = {
        hooks: [{ type: 'command', command }],
    };
    if (options.matcher)
        entry.matcher = options.matcher;
    if (typeof options.timeout === 'number')
        entry.hooks[0].timeout = options.timeout;
    entries.push(entry);
    writeJsonFile(CODEX_HOOKS_PATH, hooksFile);
    return true;
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
                    return commandMatches(h.command, BARE_BORG_REGEN, command);
                if (command === AUDIT_HOOK_COMMAND)
                    return commandMatches(h.command, BARE_LOG_AUDIT, command);
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
        const apiUrl = process.env.BORG_API_URL || 'https://api.borgmcp.ai';
        // gh#client#18: use absolute path to THIS installation's binary.
        execSync(`opencode mcp add borg --env BORG_SESSION=1 --env BORG_AGENT_KIND=opencode --env BORG_OPENCODE=1 --env BORG_API_URL=${shellQuote(apiUrl)} -- ${shellQuote(MCP_BINARY)}`, { stdio: 'inherit' });
    }
    catch (error) {
        if (error.message?.includes('command not found')) {
            throw new Error('opencode CLI not found. Please install opencode first.');
        }
        throw new Error(`Failed to add MCP server to opencode: ${error.message}`);
    }
}
//# sourceMappingURL=config-utils.js.map