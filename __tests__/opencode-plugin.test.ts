import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBorgPluginSource,
  createOpenCodePluginCore,
  installBorgPlugin,
  OPENCODE_INJECTED_ENTRY_METADATA_KEY,
  OPENCODE_RECOVERY_METADATA_KEY,
  OPENCODE_WAKE_IDENTITY_METADATA_KEY,
  openCodePluginPath,
} from '../src/opencode-plugin';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(messages: unknown[][] = [[]], enabled = true) {
  let read = 0;
  const submitted: Array<{ sessionID: string; text: string; marker: string }> = [];
  const deferred: Array<Promise<void>> = [];
  const deps = {
    defer: (task: () => Promise<void>) => { deferred.push(task()); },
    wait: vi.fn(async () => {}),
    listMessages: vi.fn(async () => messages[Math.min(read++, messages.length - 1)] ?? []),
    renderOrientation: vi.fn(async (source: string) => `orientation:${source}`),
    submitPrompt: vi.fn(async (
      sessionID: string,
      text: string,
      marker: string,
      shouldSubmit: () => boolean,
    ) => {
      if (!shouldSubmit()) return false;
      submitted.push({ sessionID, text, marker });
      return true;
    }),
    audit: vi.fn(() => null as string | null),
  };
  const core = createOpenCodePluginCore(deps, {
    enabled,
    pluginVersion: '3.4.0',
    recoveryMetadataKey: OPENCODE_RECOVERY_METADATA_KEY,
    injectedEntryMetadataKey: OPENCODE_INJECTED_ENTRY_METADATA_KEY,
    kickoffPollAttempts: 2,
    confirmationPollAttempts: 2,
    pollDelayMs: 1,
    compactFallback: 'compact fallback',
  });
  return { core, deps, submitted, deferred };
}

describe('OpenCode plugin core', () => {
  it('is inert outside a borg-launched OpenCode process', async () => {
    const h = harness([], false);
    const compact = { context: [] as string[] };
    const prompt = { message: {}, parts: [{ type: 'text', text: 'hello' }] as any[] };
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'plain' } } } });
    await h.core['experimental.session.compacting']({ sessionID: 'plain' }, compact);
    await h.core['chat.message']({ sessionID: 'plain' }, prompt);
    expect(h.deferred).toEqual([]);
    expect(compact.context).toEqual([]);
    expect(prompt.parts).toEqual([{ type: 'text', text: 'hello' }]);
    expect(h.deps.listMessages).not.toHaveBeenCalled();
  });

  it('suppresses recovery for the nonce-bearing launcher kickoff', async () => {
    const h = harness([[], [{ info: { role: 'user' }, parts: [{
      type: 'text', text: 'kickoff <!-- borg-opencode-correlation:abc -->',
    }] }]]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'launch' } } } });
    await Promise.all(h.deferred);
    expect(h.deps.listMessages).toHaveBeenCalledTimes(2);
    expect(h.deps.renderOrientation).not.toHaveBeenCalled();
    expect(h.deps.submitPrompt).not.toHaveBeenCalled();
  });

  it('submits one marked recovery turn for an empty New session and only confirms afterward', async () => {
    const marker = '3.4.0';
    const h = harness([[], [], [], [{ info: { role: 'user' }, parts: [
      { type: 'text', text: 'orientation:clear', metadata: {
        [OPENCODE_RECOVERY_METADATA_KEY]: marker,
      } },
    ] }]]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'new' } } } });
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'new' } } } });
    await Promise.all(h.deferred);
    expect(h.deferred).toHaveLength(1);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toEqual({
      sessionID: 'new',
      text: 'orientation:clear',
      marker,
    });
    expect(h.deps.listMessages).toHaveBeenCalledTimes(4);
  });

  it('ignores a marked Borg inbox entry even when foreign text contains recovery markers', async () => {
    const injected = { info: { role: 'user' }, parts: [
      {
        type: 'text',
        text: 'foreign borg-opencode-correlation:abc borg-opencode-session-orientation:3.4.0',
        metadata: { [OPENCODE_INJECTED_ENTRY_METADATA_KEY]: true },
      },
      { type: 'text', text: 'audit nudge appended by another hook' },
    ] };
    const h = harness([[], [injected]]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'foreign' } } } });
    await Promise.all(h.deferred);
    expect(h.deps.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('suppresses recovery for an ordinary persisted human prompt without trusting its text', async () => {
    const human = { info: { role: 'user' }, parts: [{
      type: 'text', text: '<!-- borg-opencode-injected-entry --> typed by a human',
    }] };
    const h = harness([[], [human]]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'human' } } } });
    await Promise.all(h.deferred);
    expect(h.deps.submitPrompt).not.toHaveBeenCalled();
  });

  it('suppresses recovery when chat.message reports a human prompt before history persists', async () => {
    const h = harness([[], [], []]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'raced' } } } });
    await h.core['chat.message']({ sessionID: 'raced' }, {
      message: {}, parts: [{ type: 'text', text: 'hello' }],
    });
    await Promise.all(h.deferred);
    expect(h.deps.submitPrompt).not.toHaveBeenCalled();
  });

  it('rechecks the chat.message guard after the history check and before network submit', async () => {
    const h = harness([[], [], []]);
    let networkSubmitted = false;
    h.deps.submitPrompt.mockImplementationOnce(async (
      _sessionID: string,
      _text: string,
      _marker: string,
      shouldSubmit: () => boolean,
    ) => {
      await h.core['chat.message']({ sessionID: 'between' }, {
        message: {}, parts: [{ type: 'text', text: 'human between check and submit' }],
      });
      if (!shouldSubmit()) return false;
      networkSubmitted = true;
      return true;
    });
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'between' } } } });
    await Promise.all(h.deferred);
    expect(h.deps.submitPrompt).toHaveBeenCalledTimes(1);
    expect(networkSubmitted).toBe(false);
  });

  it('does not let a structurally marked Borg entry set the pre-persistence human guard', async () => {
    const marker = '3.4.0';
    const h = harness([[], [], [], [], [{ info: { role: 'user' }, parts: [
      { type: 'text', text: 'orientation:clear', metadata: {
        [OPENCODE_RECOVERY_METADATA_KEY]: marker,
      } },
    ] }]]);
    await h.core.event({ event: { type: 'session.created', properties: { info: { id: 'foreign-live' } } } });
    await h.core['chat.message']({ sessionID: 'foreign-live' }, {
      message: {}, parts: [
        {
          type: 'text',
          text: 'foreign text with <!-- borg-opencode-session-orientation:3.4.0 -->',
          metadata: { [OPENCODE_INJECTED_ENTRY_METADATA_KEY]: true },
        },
      ],
    });
    await Promise.all(h.deferred);
    expect(h.deps.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('injects regenerated compact context and preserves the proven fallback', async () => {
    const h = harness();
    const output = { context: [] as string[] };
    await h.core['experimental.session.compacting']({ sessionID: 's' }, output);
    expect(output.context).toEqual(['orientation:compact']);

    h.deps.renderOrientation.mockResolvedValueOnce('');
    const fallback = { context: [] as string[] };
    await h.core['experimental.session.compacting']({ sessionID: 's' }, fallback);
    expect(fallback.context).toEqual(['compact fallback']);
  });

  it('audits prior history plus the not-yet-persisted current prompt', async () => {
    const h = harness([[{ info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }] }]]);
    h.deps.audit.mockReturnValue('audit nudge');
    const output = { message: {}, parts: [{ type: 'text', text: 'current prompt' }] as any[] };
    await h.core['chat.message']({ sessionID: 's' }, output);
    expect(h.deps.audit).toHaveBeenCalledWith([
      { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }] },
      { info: { role: 'user' }, parts: output.parts.slice(0, 1) },
    ]);
    expect(output.parts.at(-1)).toEqual({ type: 'text', text: 'audit nudge' });
  });
});

describe('generated OpenCode plugin artifact', () => {
  it('pins measured compatibility and derives behavior from the pure core', () => {
    const source = buildBorgPluginSource('3.4.0');
    expect(source).toContain(
      'borgmcp-opencode-plugin:3.4.0;opencode=1.18.15;sdk=1.17.18;' +
      'textpart-metadata=exists+persisted+tui-hidden+model-hidden;' +
      `wake-identity-key=${OPENCODE_WAKE_IDENTITY_METADATA_KEY}`,
    );
    expect(source).toContain('borg-regen');
    expect(source).toContain('experimental.session.compacting');
    expect(source).toContain('session.created');
    expect(source).not.toMatch(/\.nvm\/versions\/node|node_modules\/borgmcp\/dist/);
  });

  it('installs at the shared canonical path idempotently', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-opencode-plugin-')));
    roots.push(home);
    const expected = buildBorgPluginSource('3.4.0');
    installBorgPlugin({ homeDir: home, version: '3.4.0' });
    const pathname = openCodePluginPath(home);
    expect(fs.readFileSync(pathname, 'utf8')).toBe(expected);
    const before = fs.statSync(pathname).mtimeMs;
    installBorgPlugin({ homeDir: home, version: '3.4.0' });
    expect(fs.statSync(pathname).mtimeMs).toBe(before);
  });

  it('refuses a symlinked plugin file without changing its target', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'borg-opencode-plugin-link-')));
    roots.push(home);
    const pathname = openCodePluginPath(home);
    const target = path.join(home, 'operator-data.txt');
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(target, 'operator data');
    fs.symlinkSync(target, pathname);

    installBorgPlugin({ homeDir: home, version: '3.4.0' });

    expect(fs.lstatSync(pathname).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('operator data');
  });

  it('loads as self-contained ESM and uses the measured 1.17.18 client shape', async () => {
    vi.useFakeTimers();
    const priorSession = process.env.BORG_SESSION;
    process.env.BORG_SESSION = '1';
    try {
      const source = buildBorgPluginSource('3.4.0');
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
      const messages = vi.fn(async () => ({ data: [] }));
      const promptAsync = vi.fn(async () => ({ data: undefined }));
      const shellResult = {
        quiet() { return this; },
        nothrow() { return this; },
        then(resolve: (value: unknown) => void) {
          resolve({ exitCode: 0, stdout: Buffer.from('measured orientation') });
        },
      };
      const hooks = await module.default({
        directory: '/repo',
        client: { session: { messages, promptAsync } },
        $: () => shellResult,
      });

      const compact = { context: [] as string[] };
      await hooks['experimental.session.compacting']({ sessionID: 'compact' }, compact);
      expect(compact.context).toEqual(['measured orientation']);

      await hooks.event({ event: {
        type: 'session.created', properties: { info: { id: 'new-session' } },
      } });
      await vi.runAllTimersAsync();
      expect(messages).toHaveBeenCalledWith({
        path: { id: 'new-session' }, query: { directory: '/repo' },
      });
      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(promptAsync).toHaveBeenCalledWith({
        path: { id: 'new-session' },
        query: { directory: '/repo' },
        body: { parts: [{
          type: 'text',
          text: expect.stringContaining('measured orientation'),
          metadata: { [OPENCODE_RECOVERY_METADATA_KEY]: '3.4.0' },
        }] },
      });
    } finally {
      if (priorSession === undefined) delete process.env.BORG_SESSION;
      else process.env.BORG_SESSION = priorSession;
      vi.useRealTimers();
    }
  });
});
