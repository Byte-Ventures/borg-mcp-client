import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOpenCodeV2StartupHost } from '../../dist/opencode-v2-startup-host.js';
import { startOpenCodeV2Server } from '../../dist/opencode-v2-server.js';

writeFileSync(join(process.argv[2], 'supervisor-pid'), String(process.pid));
await runOpenCodeV2StartupHost(options => startOpenCodeV2Server({ ...options,
  spawnProcess: (_executable, _args, spawnOptions) => {
    const child = spawn(process.execPath,
      [fileURLToPath(new URL('./opencode-startup-host-native.mjs', import.meta.url))], spawnOptions);
    child.once('close', () => writeFileSync(join(options.env.BORG_STATE_ROOT, 'native-stopped'), 'reaped'));
    return child;
  },
}));
