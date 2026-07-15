/**
 * gh#557 — AES-256-GCM crypto for the keychain-less token store.
 *
 * ⚠ OBFUSCATION-GRADE, BY DESIGN. The encryption key is DERIVED from stable
 * machine+user identifiers (hostname, username, platform) — there is no
 * passphrase. This means:
 *
 *   - It DEFENDS against casual/accidental exposure: a dotfile backup, an
 *     `scp -r ~`, a synced home directory, a shoulder-surfed `cat`. The
 *     on-disk bytes are ciphertext, not a readable token.
 *   - It does NOT defend against a same-uid process or root on the SAME
 *     machine: anything that can read ~/.borg/credentials can also read the
 *     same hostname/username/platform and re-derive the key. That is an
 *     accepted limitation (SR-endorsed, gh#557 ESCALATION 2) and matches
 *     gcloud's own at-rest posture for its credential files.
 *
 * The OS keychain (config.ts default) remains the real at-rest encryption
 * path; this fallback only engages when no keychain is available (headless
 * Linux without Secret Service, etc.).
 *
 * Machine identifiers are injected (MachineKeyInputs) rather than read here,
 * both for testability and so the production caller can choose OS primitives
 * that work in headless/container environments (os.hostname()/os.userInfo()
 * never spawn a subprocess, unlike a hardware machine-id probe).
 */
export interface MachineKeyInputs {
    hostname: string;
    username: string;
    platform: string;
}
/**
 * Derive a stable 32-byte AES-256 key from machine+user identifiers.
 * Deterministic for a given machine+user (so a token written today decrypts
 * tomorrow) and distinct across machines/users.
 */
export declare function deriveMachineKey(inputs: MachineKeyInputs): Buffer;
/**
 * Encrypt a plaintext string under the given key. Returns a versioned,
 * dot-delimited envelope: `v1.<base64(iv)>.<base64(tag)>.<base64(ct)>`.
 * A fresh random IV per call means the same plaintext encrypts differently
 * every time (no deterministic-ciphertext leak).
 */
export declare function encryptString(plaintext: string, key: Buffer): string;
/**
 * Decrypt an envelope produced by encryptString. Throws on a malformed
 * envelope, a wrong key, or a tampered ciphertext (the GCM auth tag fails
 * verification) — fail-closed is correct for credential material.
 */
export declare function decryptString(envelope: string, key: Buffer): string;
//# sourceMappingURL=token-crypto.d.ts.map