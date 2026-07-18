/**
 * Parse argv for `borg assimilate [role] [--worktree <n>] [--template <n>]
 * [--no-template] [--cube-name <n>] [--host <host>] [--enroll] [--here] [--yes]`. The `assimilate`
 * subcommand token must already be stripped by the caller.
 */
export function parseAssimilateArgs(rawArgs) {
    let role;
    const flags = {};
    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg === '--worktree') {
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0) {
                return { ok: false, error: '--worktree requires a name argument (e.g. `--worktree drone-2`)' };
            }
            flags.worktree = next;
            i += 1;
        }
        else if (arg === '--template') {
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0) {
                return { ok: false, error: '--template requires a name argument (e.g. `--template software-dev`)' };
            }
            flags.template = next;
            i += 1;
        }
        else if (arg === '--no-template') {
            flags.noTemplate = true;
        }
        else if (arg === '--cube-name') {
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0) {
                return { ok: false, error: '--cube-name requires a name argument (e.g. `--cube-name my-cube`)' };
            }
            flags.cubeName = next;
            i += 1;
        }
        else if (arg === '--here') {
            flags.here = true;
        }
        else if (arg === '--host') {
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
                return { ok: false, error: '--host requires a host or URL (e.g. `--host localhost:7091`)' };
            }
            flags.server = next;
            i += 1;
        }
        else if (arg.startsWith('--host=')) {
            const value = arg.slice('--host='.length);
            if (!value) {
                return { ok: false, error: '--host requires a host or URL (e.g. `--host localhost:7091`)' };
            }
            flags.server = value;
        }
        else if (arg === '--enroll') {
            flags.enroll = true;
        }
        else if (arg === '--yes' || arg === '-y') {
            flags.yes = true;
        }
        else if (arg === '--cli') {
            const next = rawArgs[i + 1];
            if (next !== 'claude' && next !== 'codex' && next !== 'opencode') {
                return { ok: false, error: '--cli requires claude, codex, or opencode' };
            }
            flags.cli = next;
            i += 1;
        }
        else if (arg.startsWith('--cli=')) {
            const value = arg.slice('--cli='.length);
            if (value !== 'claude' && value !== 'codex' && value !== 'opencode') {
                return { ok: false, error: '--cli requires claude, codex, or opencode' };
            }
            flags.cli = value;
        }
        else if (arg === '--model' || arg === '--backend') {
            // --backend is the deprecated alias for --model (kept so existing
            // invocations don't break); both set flags.model.
            const next = rawArgs[i + 1];
            if (typeof next !== 'string' || next.length === 0) {
                return { ok: false, error: '--model requires a descriptor (e.g. `--model claude:claude-opus-4-8`)' };
            }
            const match = next.match(/^claude:[A-Za-z0-9._:\/-]+$/);
            if (!match) {
                return { ok: false, error: `invalid model descriptor '${next}' — expected claude:<model>; configure local models in the agent CLI` };
            }
            flags.model = next;
            i += 1;
        }
        else if (arg.startsWith('--model=') || arg.startsWith('--backend=')) {
            const value = arg.slice(arg.indexOf('=') + 1);
            const match = value.match(/^claude:[A-Za-z0-9._:\/-]+$/);
            if (!match) {
                return { ok: false, error: `invalid model descriptor '${value}' — expected claude:<model>; configure local models in the agent CLI` };
            }
            flags.model = value;
        }
        else if (arg.startsWith('--')) {
            return {
                ok: false,
                error: `unknown flag: ${arg}. Supported: --worktree, --template, --no-template, --cube-name, --host, --enroll, --here, --yes, --cli, --model`,
            };
        }
        else {
            if (role !== undefined) {
                return { ok: false, error: `unexpected extra argument: ${arg} (already have role "${role}")` };
            }
            role = arg;
        }
    }
    // CR-PF-F1 (drone-2 Phase F review 2026-05-18T05:04Z): spec rev-2
    // §Error paths mandates an argparse-level error when both --template
    // and --no-template are passed. Catch at parse time rather than in
    // the orchestrator so the failure happens before any auth / network /
    // worktree-spawn work.
    if (flags.template !== undefined && flags.noTemplate) {
        return { ok: false, error: '--template and --no-template are mutually exclusive' };
    }
    if (flags.enroll && flags.server === undefined) {
        return { ok: false, error: '--enroll requires --host <host>' };
    }
    return { ok: true, role, flags };
}
//# sourceMappingURL=parse-assimilate-args.js.map