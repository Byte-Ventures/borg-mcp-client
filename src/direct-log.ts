import { Buffer } from 'node:buffer';

export type LogAudience = 'broadcast' | string[];

// gh#491: hosts normalize the manifest's type-less `to` property (kept
// combinator-free by gh#485) to a string and deliver a directed audience
// JSON-encoded. Decode that one shape; any other string falls through to the
// unchanged refusals below.
function decodeSerializedAudience(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function normalizeLogAudience(rawValue: unknown): LogAudience {
  if (rawValue === 'broadcast') return rawValue;
  const value = typeof rawValue === 'string' ? decodeSerializedAudience(rawValue) : rawValue;
  const example = typeof value === 'string' && value.trim() && Buffer.byteLength(value, 'utf8') <= 120 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value.trim() : 'Build';
  const correction = rawValue === '"broadcast"'
    ? 'For broadcast use {"to":"broadcast"}, without extra quotes or an array.'
    : `For direct delivery use ${JSON.stringify({ to: [example] })}; even one recipient needs an array. For all drones use {"to":"broadcast"}.`;
  const invalid = (message: string) => new Error(`${message}. ${correction}`);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw invalid('to is required and must be "broadcast" or contain 1-100 recipient selectors');
  }
  for (const selector of value) {
    if (typeof selector !== 'string') {
      throw invalid('to recipient selectors must be strings containing 1-120 UTF-8 bytes');
    }
    const bytes = Buffer.byteLength(selector, 'utf8');
    if (bytes < 1 || bytes > 120) {
      throw invalid('to recipient selectors must be strings containing 1-120 UTF-8 bytes');
    }
    if (selector !== selector.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(selector)) {
      throw invalid('to recipient selectors must be trimmed and control-free');
    }
  }
  if (new Set(value).size !== value.length) {
    throw invalid('to recipient selectors must be unique');
  }
  return [...value];
}
