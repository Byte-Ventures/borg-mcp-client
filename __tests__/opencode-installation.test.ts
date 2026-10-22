import { describe, expect, it, vi } from 'vitest';
import {
  inspectOpenCodeInstallation,
  OpenCodeExecutableChangedError,
  parseOpenCodeVersion,
  verifyOpenCodeServerVersion,
} from '../src/opencode-installation';
import { selectOpenCodeAdapter } from '../src/opencode-adapter';

describe('OpenCode installation selection', () => {
  it.each([
    ['1.18.15\n', 1, '1.18.15'],
    ['opencode v2.1.2\n', 2, '2.1.2'],
    ['2.12.145', 2, '2.12.145'],
    ['opencode v2.2.0-preview.1+build.42', 2, '2.2.0-preview.1'],
  ])('reads published version format %s', (output, major, version) => {
    expect(parseOpenCodeVersion(output)).toMatchObject({ major, version });
  });

  it.each(['', 'debug output\n2.1.2', '2.1', '3.0.0', 'v2.1.2 garbage', '2.99999999999999999999.1'])('refuses ambiguous or unsupported version %s', (output) => {
    expect(() => parseOpenCodeVersion(output)).toThrow();
  });

  it('resolves each launch anew and reads the same executable it returns', () => {
    let executable = '/installed/opencode-one';
    let version = '1.18.15';
    const deps = {
      resolveExecutable: vi.fn(() => executable),
      readVersion: vi.fn(() => version),
    };
    const first = inspectOpenCodeInstallation({ PATH: '/old' }, deps);
    executable = '/installed/opencode-two';
    version = 'opencode v2.1.2';
    const second = inspectOpenCodeInstallation({ PATH: '/new' }, deps);
    expect(first).toMatchObject({ executable: '/installed/opencode-one', major: 1 });
    expect(second).toMatchObject({ executable: '/installed/opencode-two', major: 2 });
    expect(deps.readVersion.mock.calls).toEqual([
      ['/installed/opencode-one', { PATH: '/old' }],
      ['/installed/opencode-two', { PATH: '/new' }],
    ]);
  });

  it('does not copy child errors or version output into diagnostics', () => {
    const deps = {
      resolveExecutable: () => '/installed/opencode',
      readVersion: () => { throw new Error('OPENCODE_PASSWORD=do-not-print'); },
    };
    try { inspectOpenCodeInstallation({}, deps); } catch (error) {
      expect(String(error)).not.toContain('do-not-print');
      expect(String(error)).toContain('PATH');
      return;
    }
    throw new Error('Expected installation inspection to fail');
  });

  it('detects an executable replaced between inspection and server startup', () => {
    const installed = { executable: '/installed/opencode', ...parseOpenCodeVersion('opencode v2.1.2') };
    expect(() => verifyOpenCodeServerVersion(installed, '2.1.2')).not.toThrow();
    expect(() => verifyOpenCodeServerVersion(installed, '2.1.3')).toThrow(OpenCodeExecutableChangedError);
    expect(() => verifyOpenCodeServerVersion(installed, '1.19.3')).toThrow(OpenCodeExecutableChangedError);
    expect(() => verifyOpenCodeServerVersion(installed, undefined)).toThrow(OpenCodeExecutableChangedError);
  });
});

describe('OpenCode adapter boundary', () => {
  it.each(['1.18.15', '1.18.29', '1.19.3'])('preserves V1 launch behavior at %s', (version) => {
    const adapter = selectOpenCodeAdapter({ executable: '/installed/one', ...parseOpenCodeVersion(version) });
    expect(adapter).toMatchObject({ generation: 1, pluginEntrypoint: 'function', serverOwnership: 'tui' });
    expect(adapter.buildTuiArgs({ directory: '/worktree', port: 15555, prompt: 'kickoff', passthroughArgs: ['--model', 'provider/model'] })).toEqual([
      '/worktree', '--port', '15555', '--prompt', 'kickoff', '--model', 'provider/model',
    ]);
  });

  it('does not reject newer V2 patch versions just because they were not in a test matrix', () => {
    const adapter = selectOpenCodeAdapter({ executable: '/installed/two', ...parseOpenCodeVersion('2.1.99') });
    expect(adapter.generation).toBe(2);
    expect(adapter.buildTuiArgs({ directory: '/worktree', port: 15555, sessionId: 'ses_bound', prompt: 'must not enter argv' })).toEqual([
      '/worktree', '--server', 'http://127.0.0.1:15555', '--session', 'ses_bound',
    ]);
  });

  it.each(['--server', '--server=http://elsewhere', '--standalone', '--session', '-s', '-sother', '--continue', '--prompt', '--port', '--'])('refuses V2 passthrough retargeting through %s', (arg) => {
    const adapter = selectOpenCodeAdapter({ executable: '/installed/two', ...parseOpenCodeVersion('2.1.2') });
    expect(() => adapter.buildTuiArgs({ directory: '/worktree', port: 15555, sessionId: 'ses_bound', prompt: '', passthroughArgs: [arg] })).toThrow('ownership');
  });

  it('requires a bound session before opening the V2 TUI', () => {
    const adapter = selectOpenCodeAdapter({ executable: '/installed/two', ...parseOpenCodeVersion('2.1.2') });
    expect(() => adapter.buildTuiArgs({ directory: '/worktree', port: 15555, prompt: '' })).toThrow('bound session');
  });
});
