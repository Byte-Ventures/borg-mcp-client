import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function installConsumerPackages(consumer, packages) {
  const args = ['install', '--ignore-scripts', '--package-lock=true', '--save-exact', ...packages];
  return process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: consumer, stdio: 'pipe', timeout: 60_000 })
    : execFileSync('npm', args, { cwd: consumer, stdio: 'pipe', timeout: 60_000 });
}

export async function installTestServer(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"name":"borg-wake-e2e","private":true}\n');
  installConsumerPackages(directory, ['borgmcp-server@4.1.0']);
  return join(directory, 'node_modules', 'borgmcp-server');
}

export async function openRealServer(serverRoot, dataDirectory, persistOwnerCredential) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const load = (name) => import(pathToFileURL(join(serverRoot, 'dist', name)).href);
  const [bootstrapModule, { CoordinationApi }, credentials, httpsServer, principal, store] = await Promise.all([
    load('bootstrap.js'), load('coordination-api.js'), load('credentials.js'),
    load('https-server.js'), load('principal.js'), load('store.js'),
  ]);
  const bootstrap = await bootstrapModule.bootstrapServer(dataDirectory, '127.0.0.1', () => new Date(), persistOwnerCredential);
  const runtime = await store.openStore({ path: bootstrap.paths.database });
  const digester = new credentials.CredentialDigester(await bootstrapModule.loadDigestKey(bootstrap.paths.digestKey));
  const authority = new credentials.CredentialAuthority(runtime.credentials, digester);
  const api = new CoordinationApi(runtime, authority);
  return {
    bootstrap, runtime, authority, api, principal,
    async listen(port, authorizeCoordination) {
      return httpsServer.startHttpsServer({
        bind: { host: '127.0.0.1', port },
        tls: {
          key: await readFile(bootstrap.paths.serverKey),
          cert: await readFile(bootstrap.paths.serverCertificate),
          ca: await readFile(bootstrap.paths.caCertificate),
        },
        authorizeCoordination,
        handleCoordination: (request) => api.handle(request),
      });
    },
    close() { digester.destroy(); runtime.close(); },
  };
}
