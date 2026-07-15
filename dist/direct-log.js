export function normalizeDirectLogRecipients(value) {
    if (value == null)
        return [];
    const raw = Array.isArray(value) ? value : [value];
    const recipients = raw
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return [...new Set(recipients)];
}
//# sourceMappingURL=direct-log.js.map