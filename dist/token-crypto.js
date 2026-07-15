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
import crypto from 'crypto';
/**
 * Static application salt — domain-separates this key derivation from any
 * other use of the same machine identifiers. NOT a secret (it ships in the
 * published client); its only job is to make the derived key specific to
 * borg-mcp token storage.
 */
const KEY_SALT = 'borg-mcp/token-store/v1';
const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256
/**
 * Derive a stable 32-byte AES-256 key from machine+user identifiers.
 * Deterministic for a given machine+user (so a token written today decrypts
 * tomorrow) and distinct across machines/users.
 */
export function deriveMachineKey(inputs) {
    const material = [inputs.hostname, inputs.username, inputs.platform, KEY_SALT].join('\0');
    return crypto.createHash('sha256').update(material).digest(); // 32 bytes
}
/**
 * Encrypt a plaintext string under the given key. Returns a versioned,
 * dot-delimited envelope: `v1.<base64(iv)>.<base64(tag)>.<base64(ct)>`.
 * A fresh random IV per call means the same plaintext encrypts differently
 * every time (no deterministic-ciphertext leak).
 */
export function encryptString(plaintext, key) {
    if (key.length !== KEY_BYTES) {
        throw new Error(`token-crypto: key must be ${KEY_BYTES} bytes`);
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        ENVELOPE_VERSION,
        iv.toString('base64'),
        tag.toString('base64'),
        ciphertext.toString('base64'),
    ].join('.');
}
/**
 * Decrypt an envelope produced by encryptString. Throws on a malformed
 * envelope, a wrong key, or a tampered ciphertext (the GCM auth tag fails
 * verification) — fail-closed is correct for credential material.
 */
export function decryptString(envelope, key) {
    if (key.length !== KEY_BYTES) {
        throw new Error(`token-crypto: key must be ${KEY_BYTES} bytes`);
    }
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
        throw new Error('token-crypto: malformed or unsupported envelope');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES) {
        throw new Error('token-crypto: malformed IV');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
}
//# sourceMappingURL=token-crypto.js.map