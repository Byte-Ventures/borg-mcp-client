import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server facade CLI wiring', () => {
  it('dispatches whole-product update before the server facade or client initialization', async () => {
    const source = await readFile(new URL('../src/claude.ts', import.meta.url), 'utf8');
    const updateDispatch = source.indexOf('await runEarlyUpdate(process.argv)');

    expect(updateDispatch).toBeGreaterThan(0);
    expect(updateDispatch).toBeLessThan(source.indexOf('await runEarlyServerFacade(process.argv)'));
    expect(updateDispatch).toBeLessThan(source.indexOf('initDebugFromArgv(process.argv)'));
    expect(updateDispatch).toBeLessThan(source.indexOf('await initConsolePrefix()'));
  });

  it('initializes debug before client-owned cube init but keeps general client initialization after facade dispatch', async () => {
    const source = await readFile(new URL('../src/claude.ts', import.meta.url), 'utf8');
    const dispatch = source.indexOf('await runEarlyServerFacade(process.argv)');
    const earlyCubeInit = source.indexOf('if (isClientOwnedCubeInitArgv(process.argv))');
    const earlyDebug = source.indexOf('initDebugFromArgv(process.argv)', earlyCubeInit);
    const generalDebug = source.indexOf('initDebugFromArgv(process.argv)', earlyDebug + 1);

    expect(dispatch).toBeGreaterThan(0);
    expect(earlyCubeInit).toBeGreaterThan(0);
    expect(earlyCubeInit).toBeLessThan(earlyDebug);
    expect(earlyDebug).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(generalDebug);
    expect(dispatch).toBeLessThan(source.indexOf('handleVersionFlag()'));
    expect(dispatch).toBeLessThan(source.indexOf('await initConsolePrefix()'));
  });
});
