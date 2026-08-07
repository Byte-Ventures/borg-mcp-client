import which from 'which';
import { getProjectCliPreference, setProjectCliPreference } from './cubes.js';
import { isCodexMcpServerConfigured, isMcpServerConfigured, isOpenCodeMcpServerConfigured, } from './config-utils.js';
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
export function detectCliConfiguration() {
    return {
        claude: isMcpServerConfigured(),
        codex: isCodexMcpServerConfigured(),
        opencode: isOpenCodeMcpServerConfigured(),
    };
}
export function configuredCliNames(availability, configuration) {
    return installedCliNames(availability).filter((cli) => configuration[cli]);
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
        // An explicit --cli is an intentional request, so the caller may still
        // configure that installed CLI on demand. Automatic selection below is
        // restricted to registrations already present in the agent config.
        await deps.setPreference(explicit);
        return explicit;
    }
    const configured = configuredCliNames(availability, deps.detectConfigured());
    if (configured.length === 0) {
        throw new Error('No supported agent CLI is configured for Borg. Run `borg setup` to configure one, then run `borg` or `borg assimilate` again.');
    }
    const stored = await deps.getPreference();
    if (stored && configured.includes(stored))
        return stored;
    if (configured.length === 1) {
        await deps.setPreference(configured[0]);
        return configured[0];
    }
    if (!deps.isTTY()) {
        throw new Error('Multiple configured agent CLIs detected. Pass --cli claude, --cli codex, or --cli opencode to choose.');
    }
    const promptLines = configured.map((cli, i) => `  ${i + 1}) ${cli}`);
    const answer = (await deps.prompt(`Use which CLI for this project?\n${promptLines.join('\n')}\n[1]: `)).trim();
    if (answer === '' || answer === '1')
        return setPreferenceAndReturn(configured[0], deps);
    const num = parseInt(answer, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= configured.length) {
        return setPreferenceAndReturn(configured[num - 1], deps);
    }
    const lower = answer.toLowerCase();
    for (const cli of configured) {
        if (lower === cli)
            return setPreferenceAndReturn(cli, deps);
    }
    throw new Error(`invalid CLI choice "${answer}"`);
}
export function defaultCliChoiceDeps(prompt, isTTY) {
    return {
        detectCli: detectCliAvailability,
        detectConfigured: detectCliConfiguration,
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
    let force = false;
    let noBorgApprovalOverride = false;
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
        else if (arg === '--force') {
            force = true;
        }
        else if (arg === '--no-borg-approval-override') {
            noBorgApprovalOverride = true;
        }
        else {
            rest.push(arg);
        }
    }
    return {
        ...(cli ? { cli } : {}),
        ...(force ? { force: true } : {}),
        ...(noBorgApprovalOverride ? { noBorgApprovalOverride: true } : {}),
        rest,
    };
}
//# sourceMappingURL=cli-platform.js.map