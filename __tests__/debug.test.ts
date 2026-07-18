import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setDebug,
  isDebug,
  initDebugFromArgv,
  _resetDebugForTests,
} from '../src/debug.js';

describe('debug module — setDebug / isDebug toggle', () => {
  beforeEach(() => {
    _resetDebugForTests();
    delete process.env.BORG_DEBUG;
  });

  it('defaults to disabled', () => {
    expect(isDebug()).toBe(false);
  });

  it('setDebug(true) enables, setDebug(false) disables', () => {
    setDebug(true);
    expect(isDebug()).toBe(true);
    setDebug(false);
    expect(isDebug()).toBe(false);
  });
});

describe('initDebugFromArgv', () => {
  beforeEach(() => {
    _resetDebugForTests();
    delete process.env.BORG_DEBUG;
  });

  it('enables debug and strips --debug from argv when the flag is present', () => {
    const argv = ['node', 'borg', 'assimilate', 'builder', '--debug'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['node', 'borg', 'assimilate', 'builder']);
  });

  it('strips every --debug occurrence', () => {
    const argv = ['borg', '--debug', 'setup', '--debug'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['borg', 'setup']);
  });

  it('enables debug from a truthy BORG_DEBUG even without the flag', () => {
    process.env.BORG_DEBUG = '1';
    const argv = ['borg', 'assimilate'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['borg', 'assimilate']); // unchanged — no flag to strip
  });

  it('treats falsy BORG_DEBUG spellings as disabled', () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      _resetDebugForTests();
      process.env.BORG_DEBUG = value;
      initDebugFromArgv(['borg']);
      expect(isDebug()).toBe(false);
    }
  });

  it('leaves debug disabled when neither flag nor env is set', () => {
    initDebugFromArgv(['borg', 'setup']);
    expect(isDebug()).toBe(false);
  });
});
