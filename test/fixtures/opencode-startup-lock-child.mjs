import { withOpenCodeV2Startup } from '../../dist/opencode-v2-startup.js';

await withOpenCodeV2Startup(async () => {
  process.stdout.write('locked\n');
  // Retain the resolver from a real event source. A promise with no resolver
  // reference can be collected with its suspended async scope and SQLite handle.
  let keepAlive;
  try { await new Promise(resolve => { keepAlive = setTimeout(resolve, 300_000); }); }
  finally { clearTimeout(keepAlive); }
}, { root: process.argv[2] });
