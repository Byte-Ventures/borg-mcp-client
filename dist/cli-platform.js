import which from 'which';
import { getProjectCliPreference, setProjectCliPreference } from './cubes.js';
export function detectCliAvailability() {
    return {
        claude: findCommand('claude'),
        codex: findCommand('codex'),
        opencode: findCommand('opencode'),
    };
}
function findCommand(name) {
    try {
        return which.sync(name);
    }
    catch {
        return null;
    }
}
export function installedCliNames(availability) {
    const out = [];
    if (availability.claude)
        out.push('claude');
    if (availability.codex)
        out.push('codex');
    if (availability.opencode)
        out.push('opencode');
    return out;
}
async function setPreferenceAndReturn(cli, deps) {
    await deps.setPreference(cli);
    return cli;
}
export async function resolveCliChoice(explicit, deps) {
    const availability = deps.detectCli();
    const installed = installedCliNames(availability);
    if (installed.length === 0) {
        throw new Error('No supported agent CLI found (claude, codex, opencode). Install one of them, then run borg again.');
    }
    if (explicit) {
        if (!installed.includes(explicit)) {
            throw new Error(`${explicit} CLI is not installed.`);
        }
        await deps.setPreference(explicit);
        return explicit;
    }
    const stored = await deps.getPreference();
    if (stored && installed.includes(stored))
        return stored;
    if (installed.length === 1) {
        await deps.setPreference(installed[0]);
        return installed[0];
    }
    if (!deps.isTTY()) {
        throw new Error('Multiple agent CLIs detected. Pass --cli claude, --cli codex, or --cli opencode to choose.');
    }
    const promptLines = installed.map((cli, i) => `  ${i + 1}) ${cli}`);
    const answer = (await deps.prompt(`Use which CLI for this project?\n${promptLines.join('\n')}\n[1]: `)).trim();
    if (answer === '' || answer === '1')
        return setPreferenceAndReturn(installed[0], deps);
    const num = parseInt(answer, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= installed.length) {
        return setPreferenceAndReturn(installed[num - 1], deps);
    }
    const lower = answer.toLowerCase();
    for (const cli of installed) {
        if (lower === cli)
            return setPreferenceAndReturn(cli, deps);
    }
    throw new Error(`invalid CLI choice "${answer}"`);
}
export function defaultCliChoiceDeps(prompt, isTTY) {
    return {
        detectCli: detectCliAvailability,
        getPreference: getProjectCliPreference,
        setPreference: setProjectCliPreference,
        prompt,
        isTTY,
    };
}
const VALID_CLIS = ['claude', 'codex', 'opencode'];
export function parseCliFlag(args) {
    const rest = [];
    let cli;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--cli') {
            const next = args[i + 1];
            if (!next || !VALID_CLIS.includes(next)) {
                return { rest, error: `--cli requires one of: ${VALID_CLIS.join(', ')}` };
            }
            cli = next;
            i += 1;
        }
        else if (arg.startsWith('--cli=')) {
            const value = arg.slice('--cli='.length);
            if (!VALID_CLIS.includes(value)) {
                return { rest, error: `--cli requires one of: ${VALID_CLIS.join(', ')}` };
            }
            cli = value;
        }
        else {
            rest.push(arg);
        }
    }
    return { cli, rest };
}
//# sourceMappingURL=cli-platform.js.map