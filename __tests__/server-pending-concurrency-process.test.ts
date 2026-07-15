import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'server-pending-concurrency-child.ts',
);

async function runChild(
  mode: string,
  fixture: string,
  stateFile: string,
): Promise<any> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', child, mode],
    {
      env: {
        ...process.env,
        HOME: fixture,
        BORG_TEST_KEYCHAIN_STATE: stateFile,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) =>
    rm(fixture, { recursive: true, force: true })));
});

describe('cross-process pending tuple serialization', () => {
  it.each(['enrollment', 'cube'] as const)(
    'returns one exact %s tuple from N independent processes',
    async (mode) => {
      const fixture = await mkdtemp(join(tmpdir(), `borg-pending-${mode}-`));
      fixtures.push(fixture);
      const stateFile = join(fixture, 'keychain.json');
      const outputs = await Promise.all(Array.from({ length: 8 }, async () => {
        return await runChild(mode, fixture, stateFile) as {
          retryKey: string;
          credential?: string;
        };
      }));

      expect([...new Set(outputs.map((output) => output.retryKey))]).toHaveLength(1);
      if (mode === 'enrollment') {
        expect([...new Set(outputs.map((output) => output.credential))]).toHaveLength(1);
      }
    },
  );

  it('resumes the exact persisted enrollment tuple in a new process after response loss', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-resume-'));
    fixtures.push(fixture);
    const stateFile = join(fixture, 'keychain.json');
    const ambiguous = await runChild('ambiguous', fixture, stateFile) as {
      bodies: Array<{ payload: unknown }>;
    };
    expect(ambiguous.bodies).toHaveLength(2);
    expect(ambiguous.bodies[1].payload).toEqual(ambiguous.bodies[0].payload);

    const resumed = await runChild('resume', fixture, stateFile) as {
      bodies: Array<{ payload: unknown }>;
      token: string;
    };
    expect(resumed.bodies).toHaveLength(1);
    expect(resumed.bodies[0].payload).toEqual(ambiguous.bodies[0].payload);
    expect(resumed.token).toBe(
      (ambiguous.bodies[0].payload as { client_credential: string }).client_credential,
    );
  });
});
