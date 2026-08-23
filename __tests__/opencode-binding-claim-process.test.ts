import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetOpenCodeDroneForTests,
  connectOpenCodeDrone,
  createOpenCodeLaunchKickoff,
  disconnectOpenCodeDrone,
  injectInitialKickoff,
} from '../src/opencode-drone';
import { OPENCODE_LAUNCH_CORRELATION_METADATA_KEY } from '../src/opencode-plugin';

const execFileAsync = promisify(execFile);
const fixtureChild = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'opencode-binding-claim-child.ts',
);
const roots: string[] = [];

afterEach(() => {
  __resetOpenCodeDroneForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode cross-process binding claim', () => {
  it('arms exactly one of two resolved seats sharing a launch correlation', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'borg-opencode-claim-')));
    roots.push(fixture);
    const directory = fixture;
    const kickoff = createOpenCodeLaunchKickoff('claim kickoff');
    const session = {
      id: 'ses_000000000000claimroot',
      directory,
      time: { created: 10 },
    };
    const messages: unknown[] = [{
      info: { id: 'msg_000000000000kickoff', role: 'user' },
      parts: [{
        type: 'text',
        text: kickoff.prompt,
        metadata: { [OPENCODE_LAUNCH_CORRELATION_METADATA_KEY]: kickoff.correlationIdentity },
      }],
    }];
    let promptCount = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && url.pathname === '/session') {
        response.end(JSON.stringify([session]));
        return;
      }
      if (request.method === 'GET' && url.pathname === `/session/${session.id}`) {
        response.end(JSON.stringify(session));
        return;
      }
      if (request.method === 'GET' && url.pathname === `/session/${session.id}/message`) {
        response.end(JSON.stringify(messages));
        return;
      }
      if (request.method === 'POST' && url.pathname === `/session/${session.id}/prompt_async`) {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { parts: unknown[] };
          promptCount++;
          messages.push({
            info: { id: `msg_000000000000wake${promptCount}`, role: 'user' },
            parts: body.parts,
          });
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      await connectOpenCodeDrone({
        serverUrl,
        apiPassword: kickoff.apiPassword,
        directory,
        droneLabel: 'opencode',
        cubeName: 'borg',
        launchIdentity: kickoff.correlationIdentity,
      });
      await expect(injectInitialKickoff(kickoff)).resolves.toBe(true);
      disconnectOpenCodeDrone();

      const goPath = join(fixture, 'go');
      const readGoPath = join(fixture, 'read-go');
      const labels = ['builder-first', 'reviewer-second'];
      const children = labels.map((label) => {
        const readyPath = join(fixture, `${label}.ready`);
        const readReadyPath = join(fixture, `${label}.read-ready`);
        return {
          readyPath,
          readReadyPath,
          result: execFileAsync(process.execPath, [
            '--import',
            'tsx',
            fixtureChild,
            serverUrl,
            directory,
            label,
            'cube-one',
            kickoff.correlationIdentity,
            readyPath,
            goPath,
            readReadyPath,
            readGoPath,
          ], {
            env: { ...process.env, BORG_STATE_ROOT: fixture },
            maxBuffer: 1024 * 1024,
          }),
        };
      });
      await expect.poll(() => children.every(({ readyPath }) => existsSync(readyPath))).toBe(true);
      writeFileSync(goPath, 'go');
      await expect.poll(() => children.every(({ readReadyPath }) => existsSync(readReadyPath))).toBe(true);
      writeFileSync(readGoPath, 'read-go');
      const outputs = await Promise.all(children.map(async ({ result }) =>
        JSON.parse((await result).stdout) as { droneLabel: string; armed: boolean; injected: boolean }
      ));

      expect(outputs.filter(({ armed }) => armed)).toHaveLength(1);
      expect(outputs.filter(({ injected }) => injected)).toHaveLength(1);
      expect(outputs.find(({ armed }) => armed)?.injected).toBe(true);
      expect(outputs.find(({ armed }) => !armed)?.injected).toBe(false);
      expect(promptCount).toBe(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
