import { withOpenCodeV2Startup } from '../../dist/opencode-v2-startup.js';

await withOpenCodeV2Startup(async () => {
  process.stdout.write('locked\n');
  const keepAlive = setInterval(() => {}, 1000);
  try { await new Promise(() => {}); }
  finally { clearInterval(keepAlive); }
}, { root: process.argv[2] });
