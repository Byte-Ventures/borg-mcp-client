import { redactCloneSecrets } from './clone-security.js';
export function parseCloneArgs(rawArgs) {
    let repositoryUrl;
    let destination;
    let noLaunch = false;
    for (const arg of rawArgs) {
        if (arg === '--no-launch') {
            if (noLaunch)
                return { ok: false, error: '--no-launch was provided more than once' };
            noLaunch = true;
            continue;
        }
        if (arg.startsWith('-')) {
            const option = arg.startsWith('--') ? arg.split('=', 1)[0] : arg.slice(0, 2);
            return { ok: false, error: `unknown option ${option}; the only option is --no-launch` };
        }
        if (repositoryUrl === undefined)
            repositoryUrl = arg;
        else if (destination === undefined)
            destination = arg;
        else
            return { ok: false, error: 'unexpected extra argument' };
    }
    if (!repositoryUrl)
        return { ok: false, error: 'a repository URL is required' };
    return {
        ok: true,
        args: {
            repositoryUrl,
            ...(destination === undefined ? {} : { destination }),
            noLaunch,
        },
    };
}
export function safeCloneParseError(result) {
    return redactCloneSecrets(result.error);
}
//# sourceMappingURL=parse-clone-args.js.map