#!/usr/bin/env node
/**
 * Post-install script
 *
 * Detects local vs global installation and rejects local installs.
 * gh#653 B1: also detects whether an agent CLI (Claude Code / Codex) is present
 * and adjusts the "next step" banner so a user with no agent CLI is told to
 * install one FIRST rather than being sent into `borg setup`'s dead-end.
 */
import { detectCliAvailability, installedCliNames } from './cli-platform.js';
import { composeInstallBanner } from './postinstall-banner.js';
// Check if this is a local install (npm_config_global is not set)
const isGlobal = process.env.npm_config_global === 'true';
if (!isGlobal) {
    console.error('\n◼ Error: borg must be installed globally\n');
    console.error('Please install with:');
    console.error('  npm install -g borgmcp\n');
    console.error('Local installation is not supported.\n');
    process.exit(1);
}
// Global install — show instructions. Detect agent-CLI presence so the banner
// never points a user with no Claude Code / Codex at `borg setup` (which would
// dead-end). On any detection error, default to assuming an agent CLI is
// present so we never emit a false "install an agent CLI" warning.
let hasAgentCli = true;
try {
    hasAgentCli = installedCliNames(detectCliAvailability()).length > 0;
}
catch {
    hasAgentCli = true;
}
console.log(composeInstallBanner(hasAgentCli));
//# sourceMappingURL=postinstall.js.map