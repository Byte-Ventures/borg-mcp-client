import { randomBytes } from 'node:crypto';

export const OPENCODE_SERVER_USERNAME = 'opencode';
export const OPENCODE_SERVER_USERNAME_ENV = 'OPENCODE_SERVER_USERNAME';
export const OPENCODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';
export const BORG_OPENCODE_LAUNCH_CORRELATION_ENV = 'BORG_OPENCODE_LAUNCH_CORRELATION';
export const OPENCODE_SERVER_PASSWORD_REFERENCE = `{env:${OPENCODE_SERVER_PASSWORD_ENV}}`;

export interface OpenCodeLaunchTrust {
  apiPassword: string;
  correlationIdentity: string;
}

function random256BitIdentity(): string {
  return randomBytes(32).toString('base64url');
}

export function createOpenCodeLaunchTrust(overrides: Partial<OpenCodeLaunchTrust> = {}): OpenCodeLaunchTrust {
  const trust = {
    apiPassword: overrides.apiPassword ?? random256BitIdentity(),
    correlationIdentity: overrides.correlationIdentity ?? random256BitIdentity(),
  };
  if (!isOpenCode256BitIdentity(trust.apiPassword) || !isOpenCode256BitIdentity(trust.correlationIdentity)) {
    throw new Error('OpenCode launch trust must contain independent 256-bit identities');
  }
  if (trust.apiPassword === trust.correlationIdentity) {
    throw new Error('OpenCode API password and correlation identity must be independent');
  }
  return trust;
}

export function isOpenCode256BitIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function openCodeApiPasswordFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (env[OPENCODE_SERVER_USERNAME_ENV] !== OPENCODE_SERVER_USERNAME) return null;
  const password = env[OPENCODE_SERVER_PASSWORD_ENV];
  return isOpenCode256BitIdentity(password) ? password : null;
}
