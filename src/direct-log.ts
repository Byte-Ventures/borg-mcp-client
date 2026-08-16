export type LogAudience = 'broadcast' | string[];

export function normalizeLogAudience(value: unknown): LogAudience {
  if (value === 'broadcast') return value;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('to is required and must be "broadcast" or a non-empty recipient selector array');
  }
  if (value.some((selector) => typeof selector !== 'string' || selector.trim().length === 0)) {
    throw new Error('to recipient selectors must be non-empty strings');
  }
  return [...value];
}
