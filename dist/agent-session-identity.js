import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BORG_CLAUDE_LAUNCH_CORRELATION_ENV, resolveReportableSessionAgentKind } from './agent-runtime.js';
import { findProjectRoot } from './cubes.js';
import { ensurePrivateBorgConfigRoot } from './private-root.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { codexAppServerSocketFromEnv, isCodexSubagentSource } from './codex-wake-resolve.js';
import { resolveOpenCodeAgentSessionId } from './opencode-drone.js';
function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function claudeCorrelation(env) {
    const value = env[BORG_CLAUDE_LAUNCH_CORRELATION_ENV];
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
        return null;
    return Buffer.from(value, 'base64url').toString('base64url') === value ? value : null;
}
/** Identity only: no credential, authorization, liveness, or expiry semantics. */
export async function recordClaudeSessionStart(payload, env = process.env, worktree = findProjectRoot()) {
    const correlation = claudeCorrelation(env);
    if (!correlation)
        return;
    let sessionId;
    try {
        sessionId = JSON.parse(payload)?.session_id;
    }
    catch { /* Persist unknown rather than retain an old id. */ }
    const root = join(worktree, '.borgmcp');
    await ensurePrivateBorgConfigRoot(root);
    try {
        await writeFile(join(root, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const path = join(root, 'claude-session.json');
    const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify({
            correlation, session_id: validId(sessionId) ? sessionId : null,
            observedAt: new Date().toISOString(),
        }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
    }
    finally {
        await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT')
            throw error; });
    }
}
export async function resolveAgentSessionIdentity(env = process.env, worktree = findProjectRoot()) {
    const kind = resolveReportableSessionAgentKind(env);
    try {
        if (kind === 'claude') {
            const correlation = claudeCorrelation(env);
            if (!correlation)
                return { kind: 'unknown', reason: 'claude-launch-correlation-missing' };
            const record = JSON.parse(await readFile(join(worktree, '.borgmcp', 'claude-session.json'), 'utf8'));
            if (record?.correlation !== correlation)
                return { kind: 'unknown', reason: 'claude-launch-correlation-mismatch' };
            if (!validId(record.session_id) || typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
                return { kind: 'unknown', reason: 'claude-session-start-invalid' };
            }
            // Last observed hook, not proof of freshness: a skipped resume hook is
            // undetectable without a future per-call harness session handoff.
            return { kind: 'known', id: `claude:${record.session_id}`, source: 'claude-session-start', observedAt: record.observedAt };
        }
        if (kind === 'codex') {
            const socket = codexAppServerSocketFromEnv(env);
            if (!socket)
                return { kind: 'unknown', reason: 'codex-launch-socket-missing' };
            const client = new CodexAppServerClient(socket);
            try {
                await client.connect();
                const candidates = [];
                for (const id of await client.loadedThreadIds()) {
                    const thread = await client.readThread(id);
                    // An unreadable candidate could be another user thread; do not guess.
                    if (!thread)
                        return { kind: 'unknown', reason: 'codex-thread-unreadable' };
                    if (thread.ephemeral !== true && !isCodexSubagentSource(thread.source) &&
                        (thread.threadSource === undefined || thread.threadSource === 'user'))
                        candidates.push(thread.id);
                }
                if (candidates.length !== 1 || !validId(candidates[0]))
                    return { kind: 'unknown', reason: 'codex-user-thread-not-unique' };
                return { kind: 'known', id: `codex:${candidates[0]}`, source: 'codex-launch-thread', observedAt: new Date().toISOString() };
            }
            finally {
                client.close();
            }
        }
        if (kind === 'opencode') {
            const id = await resolveOpenCodeAgentSessionId();
            return validId(id)
                ? { kind: 'known', id: `opencode:${id}`, source: 'opencode-launch-binding', observedAt: new Date().toISOString() }
                : { kind: 'unknown', reason: 'opencode-launch-binding-unavailable-or-changed' };
        }
        return { kind: 'unknown', reason: 'agent-harness-unknown' };
    }
    catch {
        return { kind: 'unknown', reason: `${kind ?? 'agent'}-session-source-unavailable` };
    }
}
//# sourceMappingURL=agent-session-identity.js.map