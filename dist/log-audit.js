#!/usr/bin/env node
/**
 * borg-log-audit
 *
 * Domain-agnostic nudge: scans the Claude Code transcript and emits a
 * one-line warning to stdout if the drone has accumulated MATERIAL_THRESHOLD
 * or more state-changing tool calls (Edit / Write / Bash / etc.) since the
 * last borg_log post. Wired in as a UserPromptSubmit hook so the warning
 * becomes additional context for the next turn.
 *
 * Two refinements vs the v1 1-tool threshold (per drone-6's review):
 *   1. Counts material tools across all assistant turns until either the
 *      threshold is hit OR a borg_log call is found (cooldown). One
 *      diagnostic Bash no longer triggers; substantive work always does.
 *   2. Any borg_log in the scanback suppresses the nudge — so the drone
 *      gets a turn of breathing room after each post.
 *
 * Stays generic — knows nothing about git, branches, or any project's
 * conventions. Its pure scan core recognizes the Borg log tool names used by
 * Claude/Codex and OpenCode plus a small set of canonical mutating tool names.
 * If no cube is active in this project, silently exits.
 *
 * Hook input arrives as JSON on stdin (Claude Code's standard hook
 * contract). The relevant field is `transcript_path`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getActiveCube } from './cubes.js';
import { handleVersionFlag } from './version.js';
import { gateAllowsActivation } from './launch-gate.js';
import { evaluateLogAudit } from './log-audit-core.js';
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}
async function main() {
    handleVersionFlag();
    // gh#673 P1 (WI-4): the log-audit nudge only activates in
    // borg-launched sessions — vanilla `claude` gets no borg hook output.
    // Exit-0 no-op (a UserPromptSubmit hook must never block the prompt).
    // ACTIVATION-only, never a security gate.
    if (!gateAllowsActivation('borg-log-audit UserPromptSubmit hook')) {
        return;
    }
    const raw = await readStdin();
    let input = {};
    if (raw.trim()) {
        try {
            input = JSON.parse(raw);
        }
        catch {
            // No usable input — silent exit.
            return;
        }
    }
    if (!input.transcript_path || !existsSync(input.transcript_path))
        return;
    if (input.cwd && existsSync(input.cwd)) {
        try {
            process.chdir(input.cwd);
        }
        catch {
            // Best-effort only; fall back to the hook process cwd.
        }
    }
    // Only nudge if there's an active cube in this project. Otherwise the
    // hook is fully inert.
    const active = await getActiveCube();
    if (!active)
        return;
    const lines = readFileSync(input.transcript_path, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 0)
        return;
    const nudge = evaluateLogAudit(lines.map(safeParse).filter((entry) => entry !== null));
    if (nudge)
        process.stdout.write(`${nudge}\n`);
}
function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
main().catch(() => {
    // Never fail a hook — silent on error.
});
//# sourceMappingURL=log-audit.js.map