#!/usr/bin/env node
/**
 * Borg MCP Setup Wizard
 *
 * Interactive setup flow:
 * 1. Configure agent CLI MCP settings + orientation hooks
 * 2. Print how to connect to a local self-hosted Borg server
 *
 * There is no cloud authority: setup offers/executes NO cloud auth, Google
 * auth, subscription, or checkout.
 */
import prompts from 'prompts';
import chalk from 'chalk';
import which from 'which';
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
    // Step 2: Server connection — local self-hosted only.
    console.log(chalk.blue('◼ Server Connection'));
    console.log(chalk.gray('Local self-hosted server mode — no account or subscription needed.'));
    // Success message
    console.log(chalk.green.bold('\nSetup complete!\n'));
    console.log(chalk.yellow('🔄 Restart Claude Code / Codex / OpenCode (or open a new session) for the changes to take effect.\n'));
    console.log(chalk.gray('◼ Next steps:'));
    console.log(chalk.gray('1. cd into your project, then run "borg assimilate --host <host>" to join a cube'));
    console.log(chalk.gray('   (this connects to your local server and launches your agent)'));
    console.log(chalk.gray('2. Use `borg assimilate --host <host> --enroll` from the operator terminal to enroll a new client\n'));
}
// Run wizard
main().catch((error) => {
    console.error(chalk.red(`\n◼ Setup failed: ${error.message}\n`));
    process.exit(1);
});
//# sourceMappingURL=setup.js.map