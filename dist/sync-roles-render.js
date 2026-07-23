/**
 * gh#473 PR2 — non-clobbering sync output rendering.
 *
 * The dry-run output is UX-LOAD-BEARING: it must CLEARLY communicate each
 * conflict (which role/section or taxonomy class, cube-current vs
 * template-new, and how to accept) so the operator SEES what would be
 * clobbered. Pure string logic (mirrors `roster-render.ts` /
 * `list-roles-render.ts`) so it is unit-testable without the MCP runtime.
 *
 * The shape mirrors the worker's `NonClobberSyncResult`.
 */
const BIDI_CONTROL_RE = /\p{Bidi_Control}/u;
/** Escape cube-controlled text before it reaches Markdown or a terminal. */
export function escapeSyncDisplay(value) {
    return [...value].map((char) => {
        const code = char.codePointAt(0);
        if (code === 0x0a)
            return '⏎';
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
            return `\\u{${code.toString(16)}}`;
        if (BIDI_CONTROL_RE.test(char) || code === 0x2028 || code === 0x2029) {
            return `\\u{${code.toString(16)}}`;
        }
        if (char === '`')
            return '\\u{60}';
        if ('\\*_[]()<>&#|~'.includes(char))
            return `\\${char}`;
        return char;
    }).join('');
}
/** Truncate long fragment bodies for at-a-glance diffs. */
function trunc(s, n = 200) {
    if (s == null)
        return '(absent)';
    const flat = escapeSyncDisplay(s);
    return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
/**
 * Render a `NonClobberSyncResult` as an operator-facing markdown report.
 *
 * Conflicts are the headline: each is surfaced with both sides + its
 * stable accept key, and the report states explicitly that conflicts are
 * KEPT (the cube's version) unless accepted. ADDs are reported as safe
 * auto-applies. Custom roles are reported untouched.
 */
export function renderSyncRolesResult(result, templateName) {
    // Defensive guard against client/worker deploy skew (gh#9 class). A
    // pre-#473 worker returns the legacy sync-roles shape
    // ({ updated, added, unchanged, skipped, dryRun }) with no `roles[]`, so
    // `result.roles.flatMap(...)` below would throw `undefined.flatMap`.
    // Detect the legacy shape and render an actionable message instead of
    // crashing — the skew window (0.9.47+ client + pre-#473 worker) becomes a
    // clean "redeploy the worker" prompt, not an exception.
    const maybeLegacy = result;
    if (maybeLegacy.roles === undefined && 'updated' in maybeLegacy) {
        return [
            `## borg_sync-roles — unavailable (server out of date)`,
            ``,
            `The borg server returned the legacy sync-roles response shape — it is running a version older than #473, which the non-clobbering sync view does not support.`,
            ``,
            `**Action:** a server (worker) deploy is pending. Retry \`borg_sync-roles\` once it lands.`,
        ].join('\n');
    }
    const mode = result.dryRun
        ? '**DRY RUN** (review conflicts below; re-run with `apply: true` + a `decisions` map to commit)'
        : '**APPLIED**';
    const lines = [`## borg_sync-roles — ${mode}`, `Template: ${escapeSyncDisplay(templateName)}`, ''];
    // Gather all fragments across roles + taxonomy for tallying.
    const allFragments = [
        ...result.roles.flatMap((r) => r.fragments),
        ...result.taxonomy,
    ];
    const conflicts = allFragments.filter((f) => f.kind === 'conflict');
    const adds = allFragments.filter((f) => f.kind === 'add');
    const newRoles = result.roles.filter((r) => r.status === 'new');
    const customRoles = result.roles.filter((r) => r.status === 'custom-skipped');
    // ── Conflicts (the headline — what would be clobbered) ──
    if (conflicts.length > 0) {
        lines.push(`### ⚠ ${conflicts.length} CONFLICT(s) — these fragments differ between your cube and the template`);
        if (result.dryRun) {
            lines.push('These differ between your cube and the template — may be because you evolved them, or because the template changed them. ' +
                'Surfaced for review, never silently overwritten. Each defaults to **KEEP (reject)** — your version survives. ' +
                'To take the template version of a specific fragment, pass its key in `decisions` as `"<key>": "accept"`.');
        }
        else {
            lines.push('Unless explicitly accepted, each conflict was KEPT (your version preserved).');
        }
        lines.push('');
        for (const f of conflicts) {
            const applied = result.applied.acceptedConflicts.includes(f.key);
            const status = result.dryRun
                ? '(would KEEP your version)'
                : applied
                    ? '✓ accepted — template version applied'
                    : '↩ kept your version';
            lines.push(`- **${escapeSyncDisplay(f.label)}** \`${escapeSyncDisplay(f.key)}\` ${status}`);
            lines.push(`  - cube (current): "${trunc(f.cubeValue)}"`);
            lines.push(`  - template (new): "${trunc(f.templateValue)}"`);
        }
        lines.push('');
    }
    // ── Unmatched decision keys (typo'd / stale — intended accept dropped) ──
    const unmatched = result.unmatchedDecisions ?? [];
    if (unmatched.length > 0) {
        lines.push(`### ⚠ ${unmatched.length} decision key(s) matched no conflict and were ignored`);
        lines.push('These keys in your `decisions` map did not correspond to any classified conflict this run ' +
            '(typo or stale key) — their intended accept had NO effect. Check the exact keys against the conflicts above:');
        for (const k of unmatched) {
            lines.push(`- \`${escapeSyncDisplay(k)}\``);
        }
        lines.push('');
    }
    // ── Additions (safe auto-apply, zero clobber risk) ──
    if (newRoles.length > 0 || adds.length > 0) {
        lines.push(`### Additions (safe — auto-applied, zero clobber risk)`);
        for (const r of newRoles) {
            const note = result.dryRun ? '(new role — would be created)' : '✓ created';
            lines.push(`- new role **${escapeSyncDisplay(r.name)}** ${note}`);
        }
        for (const f of adds) {
            const note = result.dryRun ? '(would be added)' : '✓ added';
            lines.push(`- **${escapeSyncDisplay(f.label)}** \`${escapeSyncDisplay(f.key)}\` ${note}`);
        }
        lines.push('');
    }
    // ── Custom roles (never touched) ──
    if (customRoles.length > 0) {
        lines.push(`### Custom roles (untouched): ${customRoles.map((r) => escapeSyncDisplay(r.name)).join(', ')}`);
        lines.push('');
    }
    // ── Clean no-op ──
    if (conflicts.length === 0 && adds.length === 0 && newRoles.length === 0) {
        lines.push('✓ Cube roles + taxonomy are **up to date** with the template (no changes).');
    }
    return lines.join('\n').trimEnd();
}
//# sourceMappingURL=sync-roles-render.js.map