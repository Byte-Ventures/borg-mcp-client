import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.BORG_STATE_ROOT;
writeFileSync(join(root, 'native-starting'), String(process.pid));
// Match native boot: stdin EOF is not observed until initialization ends.
await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_BOOT_MS ?? 1000)));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ version: process.env.FIXTURE_VERSION ?? '2.2.5', pid: process.pid }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }) + '\n');
await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume(); });
server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
writeFileSync(join(root, 'native-stopped'), 'stopped');
