import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [
  serverUrl,
  directory,
  droneLabel,
  cubeName,
  launchIdentity,
  readyPath,
  goPath,
  readReadyPath,
  readGoPath,
] = process.argv.slice(2);

const originalReadFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
  const result = originalReadFileSync(path, ...(args as [any]));
  if (
    typeof path === 'string'
    && path.includes('borg-opencode-session-')
    && path.endsWith('.json')
    && String(result).includes('"droneLabel":"opencode"')
  ) {
    writeFileSync(readReadyPath, 'read');
    while (!existsSync(readGoPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return result;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();

const {
  connectOpenCodeDrone,
  injectOpenCodeEntry,
  probeOpenCodeDroneArmed,
} = await import('../../src/opencode-drone.js');

await connectOpenCodeDrone({
  serverUrl,
  apiPassword: Buffer.alloc(32, 0x41).toString('base64url'),
  directory,
  droneLabel,
  cubeName,
  launchIdentity,
});
writeFileSync(readyPath, 'ready');
while (!existsSync(goPath)) await new Promise((resolve) => setTimeout(resolve, 5));

const armed = await probeOpenCodeDroneArmed();
const injected = await injectOpenCodeEntry(`wake for ${droneLabel}`, `entry-${droneLabel}`);
process.stdout.write(JSON.stringify({ droneLabel, armed, injected }));
