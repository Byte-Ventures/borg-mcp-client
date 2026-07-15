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
 * conventions. Only the Anthropic tool name `mcp__borg__borg_log` and a
 * small set of canonical mutating tool names. If no cube is active in
 * this project, silently exits.
 *
 * Hook input arrives as JSON on stdin (Claude Code's standard hook
 * contract). The relevant field is `transcript_path`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getActiveCube } from './cubes.js';
import { handleVersionFlag } from './version.js';
import { gateAllowsActivation } from './launch-gate.js';
const MATERIAL_TOOLS = new Set([
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'Bash',
    'apply_patch',
    'exec_command',
    'functions.exec_command',
    'functions.apply_patch',
]);
const LOG_TOOL = 'mcp__borg__borg_log';
// Number of state-changing tool calls since the last borg_log that the
// drone is allowed before the audit nudges. 1 false-positives on
// diagnostic Bash (git status, ls, etc.); 3 has been comfortable in
// dogfooding — any substantive work crosses it within a turn or two.
const MATERIAL_THRESHOLD = 3;
// Cap on how many transcript entries we scan backwards before giving up.
// Sessions with thousands of turns still resolve in milliseconds at this
// bound, and anything truly old is no longer "the last span the drone
// failed to log."
const MAX_SCAN = 400;
function isUserPrompt(entry) {
    const type = entry?.type ?? entry?.role;
    if (type !== 'user')
        return false;
    const content = entry?.message?.content ?? entry?.content;
    if (typeof content === 'string')
        return content.trim().length > 0;
    if (!Array.isArray(content))
        return false;
    // A "real" user prompt has at least one text block. A tool_result-only
    // user message is a continuation of an assistant span, not a prompt.
    return content.some((b) => b?.type === 'text');
}
function isAssistant(entry) {
    const type = entry?.type ?? entry?.role;
    return type === 'assistant' || type === 'response_item';
}
function scanAssistant(entry, state) {
    const payload = entry?.payload;
    const payloadToolName = payload?.type === 'function_call' || payload?.type === 'custom_tool_call'
        ? payload.name
        : null;
    if (typeof payloadToolName === 'string') {
        if (payloadToolName === LOG_TOOL) {
            state.loggedRecently = true;
            return;
        }
        if (MATERIAL_TOOLS.has(payloadToolName))
            state.material += 1;
    }
    const content = entry?.message?.content ?? entry?.content ?? [];
    if (!Array.isArray(content))
        return;
    // Walk the blocks newest-first WITHIN the entry. The caller already
    // visits entries newest-first. Counting forward within an entry would
    // either miss post-log material work (if log is in the same entry as
    // later material blocks) or inflate the count with pre-log work that
    // the log already covered. Reversing here keeps "material since the
    // last log" honest at block granularity.
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (block?.type !== 'tool_use')
            continue;
        if (block.name === LOG_TOOL) {
            state.loggedRecently = true;
            return;
        }
        if (MATERIAL_TOOLS.has(block.name))
            state.material += 1;
    }
}
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
    // Walk the transcript backwards from the end. The trailing entry MAY
    // be the user prompt that triggered this hook; skip it if so. From
    // there, accumulate material tool calls until either we hit a borg_log
    // (cooldown — suppress) or we cross MATERIAL_THRESHOLD (nudge). The
    // scan stops after MAX_SCAN entries to bound work on huge sessions.
    let i = lines.length - 1;
    const tail = safeParse(lines[i]);
    if (tail && isUserPrompt(tail))
        i--;
    const state = { material: 0, loggedRecently: false };
    let scanned = 0;
    for (; i >= 0 && scanned < MAX_SCAN; i--, scanned++) {
        const entry = safeParse(lines[i]);
        if (!entry)
            continue;
        if (isAssistant(entry)) {
            scanAssistant(entry, state);
            // Threshold has primacy over cooldown: when both could fire on the
            // same entry (e.g. an entry containing [log, Bash, Bash, Bash]
            // where the reversed scan first counts 3 material blocks before
            // hitting the log), we want the nudge — the post-log material
            // work hasn't been logged yet.
            if (state.material >= MATERIAL_THRESHOLD) {
                process.stdout.write(`Heads up: ${state.material}+ state-changing tool calls since the last \`borg_log\` post. ` +
                    'If that work was a substantive unit (a change that ships, a blocker hit, a finding ' +
                    "worth sharing), post to the cube log per your role's conventions before continuing.\n");
                return;
            }
            if (state.loggedRecently)
                return; // cooldown
        }
    }
    // Reached MAX_SCAN or start of transcript without finding either a
    // log call or enough material work. Silent.
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