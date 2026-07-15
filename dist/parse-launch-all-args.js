// gh#556 Part 2 — argument parser for `borg launch-all [cube] [flags]` (spec §9.1).
// Pure: rawArgs → validated LaunchAllArgs | error. Mirror of parse-assimilate-args.
const SUPPORTED = '--mode <tmux|windows|pastelist>, --only <name>, --dry-run, --cli <claude|codex|opencode>, ' +
    '--no-attach, --yes/-y, --force, --launch-delay <ms>';
export function parseLaunchAllArgs(rawArgs) {
    const flags = {};
    let cubeName;
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        switch (arg) {
            case '--mode': {
                const v = rawArgs[++i];
                if (v !== 'tmux' && v !== 'windows' && v !== 'pastelist') {
                    return { ok: false, error: `--mode must be one of tmux|windows|pastelist (got: ${v ?? '<missing>'})` };
                }
                flags.mode = v;
                break;
            }
            case '--only': {
                const v = rawArgs[++i];
                if (v === undefined || v.startsWith('--')) {
                    return { ok: false, error: `--only requires a value (role name or drone label)` };
                }
                flags.only = v;
                break;
            }
            case '--cli': {
                const v = rawArgs[++i];
                if (v !== 'claude' && v !== 'codex' && v !== 'opencode') {
                    return { ok: false, error: `--cli must be one of claude|codex|opencode (got: ${v ?? '<missing>'})` };
                }
                flags.cli = v;
                break;
            }
            case '--launch-delay': {
                const v = rawArgs[++i];
                const n = v === undefined ? NaN : Number(v);
                if (!Number.isInteger(n) || n < 0) {
                    return { ok: false, error: `--launch-delay requires a non-negative integer (milliseconds); got: ${v ?? '<missing>'}` };
                }
                flags.launchDelayMs = n;
                break;
            }
            case '--dry-run':
                flags.dryRun = true;
                break;
            case '--no-attach':
                flags.noAttach = true;
                break;
            case '--yes':
            case '-y':
                flags.yes = true;
                break;
            case '--force':
                flags.force = true;
                break;
            default:
                if (arg.startsWith('-')) {
                    return { ok: false, error: `unknown flag: ${arg}. Supported: ${SUPPORTED}` };
                }
                if (cubeName !== undefined) {
                    return { ok: false, error: `unexpected extra argument: ${arg}` };
                }
                cubeName = arg;
                break;
        }
    }
    return { ok: true, args: { cubeName, flags } };
}
//# sourceMappingURL=parse-launch-all-args.js.map