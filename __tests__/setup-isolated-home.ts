/**
 * Every test file starts with a private, empty HOME and no inherited BORG_*
 * variables, so a test that forgets to isolate itself can never read or write
 * the operator's real Borg state. Tests that need a specific root still set
 * HOME / BORG_STATE_ROOT themselves.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Keep only the explicit CI opt-in. Clearing it silently skipped the real-server
// fleet gate even when its workflow requested the gate.
const ciFleet = process.env.CI === 'true' && process.env.BORG_E2E === '1';
for (const key of Object.keys(process.env)) if (key.startsWith('BORG_')) delete process.env[key];
if (ciFleet) process.env.BORG_E2E = '1';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-test-home-')));
process.env.HOME = home;
if (process.platform === 'win32') process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, '.config');
afterAll(() => rmSync(home, { recursive: true, force: true }));
