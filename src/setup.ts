#!/usr/bin/env node
/**
 * Borg MCP Setup Wizard
 *
 * Interactive setup flow:
 * 1. Configure Claude Code MCP settings
 * 2. Google OAuth authentication
 * 3. Subscription setup (web dashboard or Stripe)
 */

import prompts from 'prompts';
import chalk from 'chalk';
import open from 'open';
import which from 'which';
import { authenticateWithGoogle } from './auth.js';
import { checkSubscriptionStatus, createSubscription, probeSession } from './remote-client.js';
import { setupActionForSession } from './setup-action.js';
import {
  confirmConfigMutation,
  configMutationTargets,
  formatConfigMutationDisclosure,
  parseYesFlag,
  setupMutationPending,
} from './setup-confirm.js';
import { retrySubscriptionCheck, type SubscriptionStatus } from './subscription-retry.js';
import {
  addUserPromptSubmitHook,
  addCodexSessionStartHook,
  addCodexUserPromptSubmitHook,
  isMcpServerConfigured,
  isCodexMcpServerConfigured,
  isOpenCodeMcpServerConfigured,
  isSessionStartHookRegistered,
  isUserPromptSubmitHookRegistered,
  isCodexSessionStartHookRegistered,
  isCodexUserPromptSubmitHookRegistered,
  removeSessionStartHook,
} from './config-utils.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { handleVersionFlag } from './version.js';
import { initDebugFromArgv } from './debug.js';
import { defaultApprovalIo, setupApprovalWarnings } from './cli-tool-approval.js';

/**
 * Main setup wizard
 */
async function main() {
  // `--debug` / BORG_DEBUG observability. Wired here as well as in the
  // top-level dispatcher because `borg-setup` is its own bin (dist/setup.js)
  // and can be invoked directly, not only via `borg setup`. Idempotent.
  initDebugFromArgv(process.argv);

  handleVersionFlag();
  console.log(chalk.blue.bold('\n◼ Borg MCP Setup Wizard ◼'));

  // gh#557: `--no-browser` (alias `--device`) forces the device-code OAuth
  // flow for SSH / headless / container terminals. Scanned from argv so it
  // works both as `borg setup --no-browser` and `borg-setup --no-browser`.
  // (SSH/headless are auto-detected too; the flag is the explicit override.)
  const noBrowser =
    process.argv.includes('--no-browser') || process.argv.includes('--device');

  // Step 0: Check which agent CLIs exist
  let claudeCliPath: string | null = null;
  let codexCliPath: string | null = null;
  let opencodeCliPath: string | null = null;
  try {
    claudeCliPath = which.sync('claude');
  } catch {
    // Optional: Borg can also run with Codex or OpenCode.
  }
  try {
    codexCliPath = which.sync('codex');
  } catch {
    // Optional: Borg can also run with Claude Code or OpenCode.
  }
  try {
    opencodeCliPath = which.sync('opencode');
  } catch {
    // Optional: Borg can also run with Claude Code or Codex.
  }

  if (claudeCliPath) console.log(chalk.gray(`Found Claude CLI: ${claudeCliPath}`));
  if (codexCliPath) console.log(chalk.gray(`Found Codex CLI: ${codexCliPath}`));
  if (opencodeCliPath) console.log(chalk.gray(`Found OpenCode CLI: ${opencodeCliPath}`));
  if (claudeCliPath || codexCliPath || opencodeCliPath) console.log('');

  if (!claudeCliPath && !codexCliPath && !opencodeCliPath) {
    console.error(chalk.red('◼ No supported agent CLI found\n'));
    console.error(chalk.yellow('Please install Claude Code, Codex, or OpenCode first:'));
    console.error(chalk.gray('  Claude Code: https://claude.ai/download'));
    console.error(chalk.gray('  Codex: https://developers.openai.com/codex'));
    console.error(chalk.gray('  OpenCode: https://opencode.ai\n'));
    process.exit(1);
  }

  // Step 1: Configure every detected agent CLI. Idempotent; re-running
  // setup is the normal path for OAuth refresh and CLI self-healing.
  console.log(chalk.blue('◼ Agent CLI Integration'));

  // gh#818 P3: disclose WHICH global config files Step-1 writes, then
  // confirm before the first mutation. Disclosure-only — no token/secret is
  // written here (tokens live in the keychain; this runs before OAuth).
  // Non-TTY (CI/headless) and `--yes`/`-y` proceed WITHOUT prompting (the
  // load-bearing headless no-regress — a stdin read in a non-TTY would hang);
  // a TTY decline aborts cleanly BEFORE any addMcpServer/hook write.
  const yes = parseYesFlag(process.argv);

  // gh#844 (+ SR finding 8d9c732e): compute the per-target PENDING-mutation set
  // ONCE, from the same peeks that gate the writers below, and drive BOTH the
  // disclosure/confirm gate AND each writer from it. Consent invariant: no
  // config/hook target is mutated without prior disclosure+consent. On a pure
  // refresh (nothing pending) the prompt is skipped AND no writer runs; when
  // anything is pending the prompt fires (or --yes/headless bypasses) and only
  // the pending writers run. Deriving the gate and the writers from one source
  // means a future hook writer cannot silently re-open the consent gap.
  const claudeDetected = claudeCliPath !== null;
  const codexDetected = codexCliPath !== null;
  const opencodeDetected = opencodeCliPath !== null;
  const claudeMcpConfigured = isMcpServerConfigured();
  const codexMcpConfigured = isCodexMcpServerConfigured();
  const opencodeMcpConfigured = isOpenCodeMcpServerConfigured();
  // claude hook writes Step-1 performs: remove the legacy global SessionStart
  // hook (gh#673) if present, and add the UserPromptSubmit audit hook if absent.
  const claudeLegacyHookPending = claudeDetected && isSessionStartHookRegistered();
  const claudeUpsHookPending = claudeDetected && !isUserPromptSubmitHookRegistered();
  const codexSessionHookPending = codexDetected && !isCodexSessionStartHookRegistered();
  const codexUpsHookPending = codexDetected && !isCodexUserPromptSubmitHookRegistered();
  const claudeHookPending = claudeLegacyHookPending || claudeUpsHookPending;
  const codexHookPending = codexSessionHookPending || codexUpsHookPending;

  // gh#818 P3: disclose WHICH global config files Step-1 writes, then confirm
  // before the first mutation. Disclosure-only — no token/secret is written
  // here (tokens live in the keychain; this runs before OAuth). Non-TTY
  // (CI/headless) and `--yes`/`-y` proceed WITHOUT prompting (the load-bearing
  // headless no-regress — a stdin read in a non-TTY would hang); a TTY decline
  // aborts cleanly BEFORE any addMcpServer/hook write. gh#844: skipped entirely
  // on a pure refresh (nothing pending).
  if (
    setupMutationPending({
      claude: claudeDetected,
      codex: codexDetected,
      opencode: opencodeDetected,
      claudeMcpConfigured,
      codexMcpConfigured,
      opencodeMcpConfigured,
      claudeHookPending,
      codexHookPending,
    })
  ) {
    console.log(
      formatConfigMutationDisclosure(
        configMutationTargets({ claude: claudeDetected, codex: codexDetected, opencode: opencodeDetected })
      )
    );
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
      // gh#673 P2 (WI-1): the SessionStart orientation hook is now
      // PROJECT-LOCAL, installed by `borg assimilate` / ensured by the
      // `borg` launcher — setup no longer writes the global hook (and
      // cleans up a legacy one so old installs converge). gh#844: each write
      // is gated on its pending flag so it never runs past a skipped consent.
      if (claudeLegacyHookPending) removeSessionStartHook();
      if (claudeUpsHookPending) addUserPromptSubmitHook();
      console.log(chalk.green('◼ borg configured for Claude Code'));
    } catch (error: any) {
      console.error(chalk.red(`\n◼ Failed to configure Claude Code: ${error.message}\n`));
      process.exit(1);
    }
  }
  if (codexCliPath) {
    try {
      ensureCliMcpConfigured('codex');
      if (codexSessionHookPending) addCodexSessionStartHook();
      if (codexUpsHookPending) addCodexUserPromptSubmitHook();
      console.log(chalk.green('◼ borg configured for Codex'));
    } catch (error: any) {
      console.error(chalk.red(`\n◼ Failed to configure Codex: ${error.message}\n`));
      process.exit(1);
    }
  }
  if (opencodeCliPath) {
    try {
      ensureCliMcpConfigured('opencode');
      console.log(chalk.green('◼ borg configured for OpenCode'));
    } catch (error: any) {
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

  // Step 2: Authentication
  console.log(chalk.blue('◼ Google Authentication'));

  // gh#794: classify the saved session before deciding whether to re-auth.
  // probeSession attempts a silent refresh, so an EXPIRED id_token with a still-
  // VALID refresh_token resolves to 'valid' → we short-circuit the OAuth flow
  // instead of forcing a full re-consent (the old isAuthenticated() = presence-
  // only check forced one). SR#3: short-circuit ONLY on 'valid'; a 'dead'
  // session DOES the full re-auth (never skips the exact failure #794 fixes).
  const action = setupActionForSession(await probeSession());

  if (action === 'skip') {
    console.log(chalk.green('◼ Already signed in\n'));
  } else if (action === 'retry') {
    // A network/Google-5xx blip couldn't confirm the session. Do NOT re-auth
    // (it may be fine) and do NOT destroy the keychain (gh#34) — tell the user
    // to retry rather than forcing a full re-consent on a transient failure.
    console.error(
      chalk.yellow('\n◼ Could not reach Google to verify your session (network issue).')
    );
    console.error(chalk.yellow('Re-run `borg setup` when your connection is back.\n'));
    process.exit(1);
  } else {
    // 'reauth' (dead) — never signed in, OR the saved login is dead
    // (invalid_grant, already cleared by probeSession). Full re-auth — this is
    // the path #794 exists to reach, so NEVER short-circuit past it (SR#3).
    try {
      await authenticateWithGoogle(noBrowser ? { noBrowser: true } : undefined);
    } catch (error: any) {
      console.error(chalk.red(`\n◼ Authentication failed: ${error.message}\n`));
      // gh#557 NOTE-2: device-flow errors (access_denied / expired_token) and
      // any other auth failure exit here — give the remote user a recovery
      // path instead of a bare exit.
      console.error(chalk.yellow('Re-run `borg setup` to try again.\n'));
      process.exit(1);
    }
  }

  // Step 3: Subscription
  console.log(chalk.blue('◼ Subscription Check'));

  let status: SubscriptionStatus;
  try {
    status = await checkSubscriptionStatus();
  } catch (error: any) {
    console.error(
      chalk.yellow(`\n◼ Subscription check failed: ${error.message}`)
    );
    console.error(
      chalk.gray('◼ Retrying before falling back to the Free tier...\n')
    );
    status = { hasAccess: false };
  }

  // gh#521: a user who just subscribed via web hits propagation lag — retry a
  // few times (non-alarmingly) before declaring no subscription, instead of
  // flashing a scary "not found" immediately after payment.
  status = await retrySubscriptionCheck(status, {
    check: checkSubscriptionStatus,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry: (attempt, total) =>
      console.log(chalk.gray(`◼ Checking subscription... (attempt ${attempt}/${total})`)),
  });

  if (!status.hasAccess) {
    // gh#687: a fresh user has no subscription BY DESIGN — the Free tier is the
    // permanent entry point (no trial). Lead with that as a WIN, not a
    // "not found" failure, and present upgrading as an OFFER (Continue on Free
    // is the default). The gh#521 just-subscribed propagation-lag retry already
    // ran above; the "I already subscribed — re-check" choice covers the tail.
    console.log(
      chalk.green("◼ You're on the Free tier — permanent, no card needed: 1 cube + 3 agent sessions + 100 req/hr.")
    );
    console.log(
      chalk.gray('◼ Start using borgmcp right now. Upgrade any time: $1/month per cube, each cube adds 8 pooled agent sessions + 1000 req/hr.\n')
    );

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

    if (subscribeMethod === undefined) {
      console.log(
        chalk.yellow('\n◼ No subscription option selected — continuing on the Free tier.\n')
      );
    }

    switch (subscribeMethod) {
      case 'web':
        console.log(chalk.blue('\n◼ Opening: https://borgmcp.ai/subscribe'));
        try {
          await open('https://borgmcp.ai/subscribe');
          console.log(chalk.gray('◼ Waiting for subscription (checking every 5s for 2 min)...\n'));
          await pollForSubscription();
        } catch (error: any) {
          console.error(chalk.yellow(`\n◼ ${error.message}`));
          console.log(
            chalk.green('◼ Continuing on the Free tier. Upgrade any time from https://borgmcp.ai/subscribe.\n')
          );
        }
        break;

      case 'stripe':
        try {
          const checkoutUrl = await createSubscription();
          console.log(chalk.blue(`\n◼ Opening Stripe: ${checkoutUrl}`));
          await open(checkoutUrl);
          console.log(chalk.gray('◼ Waiting for subscription...\n'));
          await pollForSubscription();
        } catch (error: any) {
          console.error(chalk.red(`\n◼ Failed to create checkout: ${error.message}\n`));
          console.log(
            chalk.green('◼ Continuing on the Free tier. Upgrade any time from https://borgmcp.ai/subscribe.\n')
          );
        }
        break;

      case 'recheck':
        try {
          let recheckStatus: SubscriptionStatus;
          try {
            recheckStatus = await checkSubscriptionStatus();
          } catch {
            recheckStatus = { hasAccess: false };
          }
          recheckStatus = await retrySubscriptionCheck(recheckStatus, {
            check: checkSubscriptionStatus,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            onRetry: (attempt, total) =>
              console.log(chalk.gray(`◼ Re-checking subscription... (attempt ${attempt}/${total})`)),
          });
          if (recheckStatus.hasAccess) {
            console.log(chalk.green('\n◼ Subscription found!\n'));
          } else {
            console.log(chalk.yellow('\n◼ No subscription found — continuing on the Free tier.\n'));
          }
        } catch (error: any) {
          console.error(chalk.red(`\n◼ Failed to recheck: ${error.message}\n`));
          console.log(chalk.green('◼ Continuing on the Free tier.\n'));
        }
        break;

      case 'skip':
        console.log(chalk.green("\n◼ You're all set on the Free tier: 1 cube, 3 agent sessions, 100 req/hr.\n"));
        break;
    }
  } else {
    console.log(chalk.green('◼ Active subscription found'));

    if (status.expiresAt) {
      const expiresAt = new Date(status.expiresAt);
      console.log(chalk.gray(`  Expires: ${expiresAt.toLocaleDateString()}\n`));
    } else {
      console.log('');
    }
  }

  // Success message
  console.log(chalk.green.bold('Setup complete!\n'));
  console.log(chalk.yellow('🔄 Restart Claude Code / Codex / OpenCode (or open a new session) for the changes to take effect.\n'));
  // gh#653 B2: after setup the user has NO cube yet, so "run borg" was a
  // dead-end — `borg assimilate` (run in a project dir) is what joins/creates
  // a cube AND launches the agent. Point them there first.
  console.log(chalk.gray('◼ Next steps:'));
  console.log(chalk.gray('1. cd into your project, then run "borg assimilate" to join a cube'));
  console.log(chalk.gray('   (this creates/joins the cube and launches your agent)'));
  console.log(chalk.gray('2. Manage cubes and subscription at https://borgmcp.ai/dashboard\n'));
}

/**
 * Poll for subscription activation
 * Checks every 5 seconds for 2 minutes (24 attempts)
 */
async function pollForSubscription(): Promise<void> {
  const maxAttempts = 24;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
      const status = await checkSubscriptionStatus();

      if (status.hasAccess) {
        console.log(chalk.green('◼ Subscription activated!\n'));
        return;
      }
    } catch (error) {
      // Continue polling even on errors
    }
  }

  throw new Error('Timeout - Run setup again after subscribing');
}

// Run wizard
main().catch((error) => {
  console.error(chalk.red(`\n◼ Setup failed: ${error.message}\n`));
  process.exit(1);
});
