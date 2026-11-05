import { withOpenCodeV2StartupHost } from '../../dist/opencode-v2-startup-host.js';

const root = process.argv[2];
const launch = withOpenCodeV2StartupHost(async host => {
  await host.startServer({
    installation: { executable: process.execPath, version: '2.2.5', major: 2, minor: 2, patch: 5, prerelease: null },
    directory: root, env: { ...process.env, BORG_STATE_ROOT: root, FIXTURE_BOOT_MS: '120000' },
    readyTimeoutMs: 60000, shutdownTimeoutMs: 100,
  });
}, { root, worker: new URL('./opencode-startup-host-worker.mjs', import.meta.url) });
if (process.argv[3] === 'early-exit') process.exit(0);
await launch;
