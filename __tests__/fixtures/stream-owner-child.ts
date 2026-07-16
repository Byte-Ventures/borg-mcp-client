import { acquireStreamLease } from '../../src/stream-owner.js';

const [cubeId, droneId, locksDir] = process.argv.slice(2);
if (!cubeId || !droneId || !locksDir) process.exit(2);

const lease = await acquireStreamLease(cubeId, droneId, 70_000, { locksDir });
if (!lease) process.exit(3);

process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
