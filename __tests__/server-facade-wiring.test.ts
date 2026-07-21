import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server facade CLI wiring', () => {
  it('dispatches server commands before client debug, version, prefix, or startup state', async () => {
    const source = await readFile(new URL('../src/claude.ts', import.meta.url), 'utf8');
    const dispatch = source.indexOf('await runEarlyServerFacade(process.argv)');

    expect(dispatch).toBeGreaterThan(0);
    expect(dispatch).toBeLessThan(source.indexOf('initDebugFromArgv(process.argv)'));
    expect(dispatch).toBeLessThan(source.indexOf('handleVersionFlag()'));
    expect(dispatch).toBeLessThan(source.indexOf('await initConsolePrefix()'));
  });
});
