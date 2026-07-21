/**
 * Tests for the 0600 file credential backend (token-store.ts). The OS-keychain
 * backend (makeKeychainBackend / @napi-rs/keyring) was DELETED with the Queen
 * rescope; local-server credentials now rest in the 0600 file store exclusively.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileBackend } from '../src/token-store.js';

describe('makeFileBackend (0600 credential store — Queen rescope)', () => {
  const fixtures: string[] = [];
  afterEach(() => {
    for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  });
  const store = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'borg-file-backend-')));
    fixtures.push(dir);
    return join(dir, 'credentials.json');
  };

  it('round-trips set/get/delete against the real 0600 file, several accounts in one file', async () => {
    const path = store();
    const backend = makeFileBackend(path);
    await backend.set('borg-server-credential:aaa', 'ENROLL');
    await backend.set('borg-server-session:bbb', 'BEARER');
    expect(await backend.get('borg-server-credential:aaa')).toBe('ENROLL');
    expect(await backend.get('borg-server-session:bbb')).toBe('BEARER');
    // Both accounts live in ONE 0600 file.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await backend.delete('borg-server-credential:aaa');
    expect(await backend.get('borg-server-credential:aaa')).toBeNull();
    expect(await backend.get('borg-server-session:bbb')).toBe('BEARER');
  });

  it('get on a missing account is null; delete on a missing account is a silent no-op', async () => {
    const backend = makeFileBackend(store());
    expect(await backend.get('nope')).toBeNull();
    await expect(backend.delete('nope')).resolves.toBeUndefined();
  });

  it('persists across a fresh backend instance (survives process restart)', async () => {
    const path = store();
    await makeFileBackend(path).set('borg-server-session:k', 'V');
    expect(await makeFileBackend(path).get('borg-server-session:k')).toBe('V');
  });

  it('CR4: a malformed store FAILS CLOSED on every op and is never overwritten (byte-preservation)', async () => {
    const path = store();
    const corrupt = 'not-json-at-all';
    writeFileSync(path, corrupt);
    chmodSync(path, 0o600); // isolate malformed detection from the perm check
    const backend = makeFileBackend(path);
    await expect(backend.get('borg-server-session:k')).rejects.toThrow(/malformed/i);
    await expect(backend.set('borg-server-session:k', 'V')).rejects.toThrow(/malformed/i);
    await expect(backend.delete('borg-server-session:k')).rejects.toThrow(/malformed/i);
    // No op overwrote the corrupt bytes.
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it('CR4: a wrong-version store FAILS CLOSED and is preserved', async () => {
    const path = store();
    const wrongVersion = JSON.stringify({ version: 2, accounts: { 'borg-server-session:k': 'V' } });
    writeFileSync(path, wrongVersion);
    chmodSync(path, 0o600);
    const backend = makeFileBackend(path);
    await expect(backend.set('borg-server-session:x', 'Y')).rejects.toThrow(/malformed|unsupported version/i);
    expect(readFileSync(path, 'utf8')).toBe(wrongVersion);
  });

  it('CR#2: a valid-JSON store with a NON-STRING account value FAILS CLOSED and is preserved', async () => {
    const path = store();
    // version 1, accounts is an object — but one value is not a string.
    const badValue = JSON.stringify({ version: 1, accounts: { 'borg-server-session:k': { nested: true } } });
    writeFileSync(path, badValue);
    chmodSync(path, 0o600);
    const backend = makeFileBackend(path);
    await expect(backend.get('borg-server-session:k')).rejects.toThrow(/malformed/i);
    await expect(backend.set('borg-server-session:x', 'Y')).rejects.toThrow(/malformed/i);
    await expect(backend.delete('borg-server-session:k')).rejects.toThrow(/malformed/i);
    expect(readFileSync(path, 'utf8')).toBe(badValue);
  });

  it('CR#2: a group/other-readable credential store FAILS CLOSED on READ (0600 enforced on read)', async () => {
    const path = store();
    const valid = JSON.stringify({ version: 1, accounts: { 'borg-server-session:k': 'V' } });
    writeFileSync(path, valid);
    chmodSync(path, 0o640); // group-readable secret at rest — refused on READ
    const backend = makeFileBackend(path);
    await expect(backend.get('borg-server-session:k')).rejects.toThrow(/insecure permissions|0600/i);
    expect(readFileSync(path, 'utf8')).toBe(valid);
  });

  it('CR#2: a MISSING store still initializes empty (ENOENT is the only empty-init path)', async () => {
    const backend = makeFileBackend(store());
    await expect(backend.get('borg-server-session:k')).resolves.toBeNull();
    await expect(backend.set('borg-server-session:k', 'V')).resolves.toBeUndefined();
  });
});
