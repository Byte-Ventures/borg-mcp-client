import { redactCloneSecrets } from './clone-security.js';
import { parseQuickstartArgs } from './parse-quickstart-args.js';
export function parseCloneArgs(rawArgs) {
    let repositoryUrl;
    let destination;
    let checkoutOnly = false;
    const quickstartArgs = [];
    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg === '--checkout-only' || arg === '--no-launch') {
            if (checkoutOnly)
                return { ok: false, error: 'checkout-only mode was provided more than once' };
            checkoutOnly = true;
            continue;
        }
        if (arg === '--yes' || arg === '-y') {
            quickstartArgs.push(arg);
            continue;
        }
        if (arg === '--template' || arg === '--role') {
            quickstartArgs.push(arg);
            const value = rawArgs[++i];
            if (value !== undefined)
                quickstartArgs.push(value);
            continue;
        }
        if (arg.startsWith('-')) {
            const option = arg.startsWith('--') ? arg.split('=', 1)[0] : arg.slice(0, 2);
            return {
                ok: false,
                error: `unknown option ${option}; supported: --template, --role, --yes/-y, --checkout-only, --no-launch`,
            };
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
    const parsedQuickstart = parseQuickstartArgs(quickstartArgs);
    if (!parsedQuickstart.ok)
        return parsedQuickstart;
    if (checkoutOnly && quickstartArgs.length > 0) {
        return { ok: false, error: '--checkout-only/--no-launch cannot be combined with --template, --role, or --yes/-y' };
    }
    return {
        ok: true,
        args: {
            repositoryUrl,
            ...(destination === undefined ? {} : { destination }),
            checkoutOnly,
            ...parsedQuickstart.args,
        },
    };
}
export function safeCloneParseError(result) {
    return redactCloneSecrets(result.error);
}
//# sourceMappingURL=parse-clone-args.js.map