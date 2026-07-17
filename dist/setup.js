#!/usr/bin/env node
/**
 * Borg MCP Setup Wizard
 *
 * Interactive setup flow:
 * 1. Configure agent CLI MCP settings
 * 2. Choose authority: local server (default) or Cloud
 * 3. [Cloud only] Google OAuth authentication + subscription via seam
 */
import prompts from 'prompts';
import chalk from 'chalk';
import open from 'open';
import which from 'which';
import { authenticateWithGoogle } from './auth.js';
import { checkSubscriptionStatus, createSubscription, probeSession } from './remote-client.js';
import { handleAuthorityResult, runSetupAuthority } from './setup-authority.js';
import { confirmConfigMutation, configMutationTargets, formatConfigMutationDisclosure, parseYesFlag, setupMutationPending, } from './setup-confirm.js';
import { addUserPromptSubmitHook, addCodexSessionStartHook, addCodexUserPromptSubmitHook, isMcpServerConfigured, isCodexMcpServerConfigured, isOpenCodeMcpServerConfigured, isSessionStartHookRegistered, isUserPromptSubmitHookRegistered, isCodexSessionStartHookRegistered, isCodexUserPromptSubmitHookRegistered, removeSessionStartHook, } from './config-utils.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { handleVersionFlag } from './version.js';
import { initDebugFromArgv } from './debug.js';
import { defaultApprovalIo, setupApprovalWarnings } from './cli-tool-approval.js';
/**
 * Main setup wizard
 */
async function main() {
    initDebugFromArgv(process.argv);
    handleVersionFlag();
    console.log(chalk.blue.bold('\n◼ Borg MCP Setup Wizard ◼'));
    const noBrowser = process.argv.includes('--no-browser') || process.argv.includes('--device');
    let claudeCliPath = null;
    let codexCliPath = null;
    let opencodeCliPath = null;
    try {
        claudeCliPath = which.sync('claude');
    }
    catch { /* optional */ }
    try {
        codexCliPath = which.sync('codex');
    }
    catch { /* optional */ }
    try {
        opencodeCliPath = which.sync('opencode');
    }
    catch { /* optional */ }
    if (claudeCliPath)
        console.log(chalk.gray(`Found Claude CLI: ${claudeCliPath}`));
    if (codexCliPath)
        console.log(chalk.gray(`Found Codex CLI: ${codexCliPath}`));
    if (opencodeCliPath)
        console.log(chalk.gray(`Found OpenCode CLI: ${opencodeCliPath}`));
    if (claudeCliPath || codexCliPath || opencodeCliPath)
        console.log('');
    if (!claudeCliPath && !codexCliPath && !opencodeCliPath) {
        console.error(chalk.red('◼ No supported agent CLI found\n'));
        console.error(chalk.yellow('Please install Claude Code, Codex, or OpenCode first:'));
        console.error(chalk.gray('  Claude Code: https://claude.ai/download'));
        console.error(chalk.gray('  Codex: https://developers.openai.com/codex'));
        console.error(chalk.gray('  OpenCode: https://opencode.ai\n'));
        process.exit(1);
    }
    // Step 1: Configure every detected agent CLI
    console.log(chalk.blue('◼ Agent CLI Integration'));
    const yes = parseYesFlag(process.argv);
    const claudeDetected = claudeCliPath !== null;
    const codexDetected = codexCliPath !== null;
    const opencodeDetected = opencodeCliPath !== null;
    const claudeMcpConfigured = isMcpServerConfigured();
    const codexMcpConfigured = isCodexMcpServerConfigured();
    const opencodeMcpConfigured = isOpenCodeMcpServerConfigured();
    const claudeLegacyHookPending = claudeDetected && isSessionStartHookRegistered();
    const claudeUpsHookPending = claudeDetected && !isUserPromptSubmitHookRegistered();
    const codexSessionHookPending = codexDetected && !isCodexSessionStartHookRegistered();
    const codexUpsHookPending = codexDetected && !isCodexUserPromptSubmitHookRegistered();
    const claudeHookPending = claudeLegacyHookPending || claudeUpsHookPending;
    const codexHookPending = codexSessionHookPending || codexUpsHookPending;
    if (setupMutationPending({
        claude: claudeDetected,
        codex: codexDetected,
        opencode: opencodeDetected,
        claudeMcpConfigured,
        codexMcpConfigured,
        opencodeMcpConfigured,
        claudeHookPending,
        codexHookPending,
    })) {
        console.log(formatConfigMutationDisclosure(configMutationTargets({ claude: claudeDetected, codex: codexDetected, opencode: opencodeDetected })));
        const mutationDecision = await confirmConfigMutation({
            isTTY: process.stdin.isTTY === true,
            yes,
            confirm: async () => {
                const { proceed } = await prompts({
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Continue with these changes?',
                    initial: true,
                });
                return proceed === true;
            },
        });
        if (mutationDecision === 'abort') {
            console.log(chalk.yellow('\n◼ Setup cancelled — no changes made.\n'));
            process.exit(0);
        }
    }
    console.log('');
    if (claudeCliPath) {
        try {
            ensureCliMcpConfigured('claude');
            if (claudeLegacyHookPending)
                removeSessionStartHook();
            if (claudeUpsHookPending)
                addUserPromptSubmitHook();
            console.log(chalk.green('◼ borg configured for Claude Code'));
        }
        catch (error) {
            console.error(chalk.red(`\n◼ Failed to configure Claude Code: ${error.message}\n`));
            process.exit(1);
        }
    }
    if (codexCliPath) {
        try {
            ensureCliMcpConfigured('codex');
            if (codexSessionHookPending)
                addCodexSessionStartHook();
            if (codexUpsHookPending)
                addCodexUserPromptSubmitHook();
            console.log(chalk.green('◼ borg configured for Codex'));
        }
        catch (error) {
            console.error(chalk.red(`\n◼ Failed to configure Codex: ${error.message}\n`));
            process.exit(1);
        }
    }
    if (opencodeCliPath) {
        try {
            ensureCliMcpConfigured('opencode');
            console.log(chalk.green('◼ borg configured for OpenCode'));
        }
        catch (error) {
            console.error(chalk.red(`\n◼ Failed to configure OpenCode: ${error.message}\n`));
            process.exit(1);
        }
    }
    const approvalIo = defaultApprovalIo(async () => '', () => false, {
        cwd: process.cwd(),
        env: process.env,
        codexArgs: [],
    });
    for (const warning of await setupApprovalWarnings(approvalIo, {
        codex: codexDetected,
        opencode: opencodeDetected,
    })) {
        console.log(chalk.yellow(`warning: ${warning}`));
    }
    console.log('');
    // Step 2: Authority choice — local server (default) or Cloud
    console.log(chalk.blue('◼ Server Connection'));
    const { authority } = await prompts({
        type: 'select',
        name: 'authority',
        message: 'Connect to:',
        choices: [
            {
                title: '◼ Local server — no account required (recommended)',
                value: 'local',
                description: 'Run your own borg server on this machine or network'
            },
            {
                title: '◼ Borg Cloud (borgmcp.ai)',
                value: 'cloud',
                description: 'Managed cloud service — requires Google sign-in and subscription'
            }
        ],
        initial: 0,
    });
    if (authority === undefined) {
        console.log(chalk.yellow('\n◼ No choice selected — defaulting to local server.\n'));
    }
    const authorityResult = await runSetupAuthority(authority === 'cloud' ? 'cloud' : 'local', {
        probeSession,
        authenticateWithGoogle,
        checkSubscriptionStatus,
        createSubscription,
        openUrl: async (url) => { await open(url); },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        selectSubscribeMethod: async () => {
            const { subscribeMethod } = await prompts({
                type: 'select',
                name: 'subscribeMethod',
                message: "You're ready on the Free tier. Want to do more?",
                choices: [
                    {
                        title: '◼ Continue on the Free tier (recommended)',
                        value: 'skip',
                        description: 'Start now — 1 cube, 3 agent sessions, 100 req/hr. No payment required.'
                    },
                    {
                        title: '◼ Upgrade to Cube tier — $1/month per cube',
                        value: 'web',
                        description: 'Each cube adds 8 pooled agent sessions + 1000 req/hr. Opens the subscribe page in your browser.'
                    },
                    {
                        title: '◼ Quick Stripe checkout',
                        value: 'stripe',
                        description: 'Fast upgrade checkout in the browser'
                    },
                    {
                        title: '◼ I already subscribed — re-check',
                        value: 'recheck',
                        description: 'Re-check now — a just-completed subscription can take a moment to activate'
                    }
                ]
            });
            return subscribeMethod;
        },
        log: (...args) => console.log(...args),
        logError: (...args) => console.error(...args),
    }, { noBrowser });
    if (handleAuthorityResult(authorityResult, console.log, console.error) !== 0) {
        process.exit(1);
    }
    // Success message
    console.log(chalk.green.bold('Setup complete!\n'));
    console.log(chalk.yellow('🔄 Restart Claude Code / Codex / OpenCode (or open a new session) for the changes to take effect.\n'));
    const useCloud = authorityResult.useCloud;
    console.log(chalk.gray('◼ Next steps:'));
    console.log(chalk.gray('1. cd into your project, then run "borg assimilate" to join a cube'));
    console.log(chalk.gray('   (this creates/joins the cube and launches your agent)'));
    if (useCloud) {
        console.log(chalk.gray('2. Manage cubes and subscription at https://borgmcp.ai/dashboard\n'));
    }
    else {
        console.log(chalk.gray('2. Use `borg assimilate --host <host>` to connect to your local server\n'));
    }
}
// Run wizard
main().catch((error) => {
    console.error(chalk.red(`\n◼ Setup failed: ${error.message}\n`));
    process.exit(1);
});
//# sourceMappingURL=setup.js.map