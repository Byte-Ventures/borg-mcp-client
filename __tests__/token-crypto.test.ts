/**
 * Tests for gh#557 encrypted-file token crypto (keychain-less fallback).
 *
 * When the OS keychain is unavailable (headless Linux without Secret
 * Service, locked keychain), tokens are stored in ~/.borg/credentials
 * encrypted with AES-256-GCM under a key DERIVED from stable machine+user
 * identifiers. This is explicitly OBFUSCATION-GRADE: it defends against
 * casual/accidental exposure (a dotfile backup, an `scp -r ~`), NOT against
 * a same-uid process or root — those can re-derive the key from the same
 * inputs. The threat model + limitation are documented in the impl + docs.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveMachineKey,
  encryptString,
  decryptString,
  type MachineKeyInputs,
} from '../src/token-crypto.js';

const INPUTS_A: MachineKeyInputs = {
  hostname: 'builder-laptop',
  username: 'theodor',
  platform: 'darwin',
};
const INPUTS_B: MachineKeyInputs = {
  hostname: 'other-host',
  username: 'theodor',
  platform: 'darwin',
};

describe('deriveMachineKey (gh#557)', () => {
  it('produces a 32-byte (AES-256) key', () => {
    expect(deriveMachineKey(INPUTS_A)).toHaveLength(32);
  });

  it('is deterministic for the same machine+user inputs', () => {
    expect(deriveMachineKey(INPUTS_A).equals(deriveMachineKey(INPUTS_A))).toBe(true);
  });

  it('differs when any identifying input differs', () => {
    expect(deriveMachineKey(INPUTS_A).equals(deriveMachineKey(INPUTS_B))).toBe(false);
  });
});

describe('encryptString / decryptString (gh#557 AES-256-GCM)', () => {
  const key = deriveMachineKey(INPUTS_A);

  it('round-trips a plaintext value', () => {
    const secret = 'eyJ...id-token-value...';
    const envelope = encryptString(secret, key);
    expect(decryptString(envelope, key)).toBe(secret);
  });

  it('does not store the plaintext in the envelope', () => {
    const secret = 'super-secret-refresh-token';
    const envelope = encryptString(secret, key);
    expect(envelope).not.toContain(secret);
  });

  it('produces a different envelope each call (random IV)', () => {
    const secret = 'same-input';
    expect(encryptString(secret, key)).not.toBe(encryptString(secret, key));
  });

  it('throws when decrypting with a different (wrong-machine) key', () => {
    const envelope = encryptString('value', key);
    const wrongKey = deriveMachineKey(INPUTS_B);
    expect(() => decryptString(envelope, wrongKey)).toThrow();
  });

  it('throws on a tampered ciphertext (GCM auth tag mismatch)', () => {
    const envelope = encryptString('value', key);
    // Flip a character in the final (ciphertext) segment of the envelope.
    const parts = envelope.split('.');
    const ct = parts[parts.length - 1];
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    parts[parts.length - 1] = flipped;
    expect(() => decryptString(parts.join('.'), key)).toThrow();
  });

  it('throws on a malformed envelope (not the versioned format)', () => {
    expect(() => decryptString('garbage', key)).toThrow();
  });
});
