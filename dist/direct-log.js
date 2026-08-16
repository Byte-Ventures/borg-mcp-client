import { Buffer } from 'node:buffer';
export function normalizeLogAudience(value) {
    if (value === 'broadcast')
        return value;
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
        throw new Error('to is required and must be "broadcast" or contain 1-100 recipient selectors');
    }
    for (const selector of value) {
        if (typeof selector !== 'string') {
            throw new Error('to recipient selectors must be strings containing 1-120 UTF-8 bytes');
        }
        const bytes = Buffer.byteLength(selector, 'utf8');
        if (bytes < 1 || bytes > 120) {
            throw new Error('to recipient selectors must be strings containing 1-120 UTF-8 bytes');
        }
        if (selector !== selector.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(selector)) {
            throw new Error('to recipient selectors must be trimmed and control-free');
        }
    }
    if (new Set(value).size !== value.length) {
        throw new Error('to recipient selectors must be unique');
    }
    return [...value];
}
//# sourceMappingURL=direct-log.js.map