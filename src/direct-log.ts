export function normalizeDirectLogRecipients(value: unknown): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const recipients = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(recipients)];
}
