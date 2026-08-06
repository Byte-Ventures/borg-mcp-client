/** Pure argument parsing for `borg clone <repo-url>`. */
function valueFor(rawArgs, index, flag) {
    const value = rawArgs[index + 1];
    if (value === undefined || value.startsWith('--')) {
        return { error: `${flag} requires a value` };
    }
    if (value.length === 0)
        return { error: `${flag} requires a non-empty value` };
    return { value };
}
/** Parse clone args without touching the filesystem or spawning Git. */
export function parseCloneArgs(rawArgs) {
    const flags = { noLaunch: false };
    let repositoryUrl;
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg === '--no-launch') {
            if (flags.noLaunch)
                return { ok: false, error: '--no-launch was provided more than once' };
            flags.noLaunch = true;
            continue;
        }
        const valueFlag = arg === '--destination' || arg === '--name' || arg === '--branch';
        if (valueFlag) {
            const result = valueFor(rawArgs, i, arg);
            if ('error' in result)
                return { ok: false, error: result.error };
            i++;
            const key = arg.slice(2);
            if (flags[key] !== undefined)
                return { ok: false, error: `${arg} was provided more than once` };
            flags[key] = result.value;
            continue;
        }
        if (arg.startsWith('-')) {
            return {
                ok: false,
                error: `unknown option ${arg}; supported options are --destination, --name, --branch, and --no-launch`,
            };
        }
        if (repositoryUrl !== undefined) {
            return { ok: false, error: `unexpected extra argument: ${arg}` };
        }
        repositoryUrl = arg;
    }
    if (repositoryUrl === undefined) {
        return { ok: false, error: 'a repository URL is required' };
    }
    return { ok: true, args: { repositoryUrl, flags } };
}
//# sourceMappingURL=parse-clone-args.js.map