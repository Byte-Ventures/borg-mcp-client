import { NEW_CUBE_TEMPLATE_PRESENTATIONS } from 'borgmcp-shared/templates';
const templates = new Set(NEW_CUBE_TEMPLATE_PRESENTATIONS.map(({ name }) => name));
function parseRole(value) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?::([1-9]\d*))?$/.exec(value);
    if (!match)
        return null;
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return Number.isSafeInteger(count) ? { slug: match[1], count } : null;
}
export function parseQuickstartArgs(rawArgs) {
    const args = { roles: [], yes: false };
    for (let i = 0; i < rawArgs.length; i += 1) {
        const arg = rawArgs[i];
        if (arg === '--yes' || arg === '-y') {
            args.yes = true;
            continue;
        }
        if (arg === '--template') {
            const value = rawArgs[++i];
            if (!value)
                return { ok: false, error: '--template requires software-dev, starter, or local-model' };
            if (!templates.has(value))
                return { ok: false, error: `unknown template '${value}'; choose software-dev, starter, or local-model` };
            if (args.template !== undefined)
                return { ok: false, error: '--template was provided more than once' };
            args.template = value;
            continue;
        }
        if (arg === '--role') {
            const value = rawArgs[++i];
            if (!value)
                return { ok: false, error: '--role requires <slug>[:<count>]' };
            const role = parseRole(value);
            if (!role)
                return { ok: false, error: `invalid role '${value}'; use <slug>[:<positive-count>]` };
            args.roles.push(role);
            continue;
        }
        return { ok: false, error: `unknown option: ${arg}. Supported: --template, --role, --yes/-y` };
    }
    return { ok: true, args };
}
//# sourceMappingURL=parse-quickstart-args.js.map