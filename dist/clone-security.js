/** Redaction and fail-closed credential detection for untrusted Git remotes. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;
const URL_SUFFIX_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s?#)]+)([?#])[^\s)]*/gi;
const NAMED_SECRET_RE = /([?&](?:access[_-]?token|api[_-]?key|auth(?:entication)?|credential|password|passwd|private[_-]?key|secret|token)=)[^&#\s)]+/gi;
const NAMED_SECRET_TEST_RE = new RegExp(NAMED_SECRET_RE.source, 'i');
const OPTION_SECRET_RE = /((?:^|[\s("'`])--(?:access[_-]?token|api[_-]?key|auth(?:entication)?|credential|password|passwd|private[_-]?key|secret|token)=)[^\s)]*/gi;
const SCP_REMOTE_RE = /^[^@\s/:]+@[^:\s]+:[^\s]+$/;
export function redactCloneSecrets(value) {
    return value
        .replace(URL_USERINFO_RE, '$1<credentials>@')
        .replace(URL_SUFFIX_RE, '$1$2<redacted>')
        .replace(NAMED_SECRET_RE, '$1<redacted>')
        .replace(OPTION_SECRET_RE, '$1<redacted>')
        .replace(/(^|[\s("'`])[^/\s:@]+:[^@\s/]+@(?=[^\s/])/g, '$1<credentials>@');
}
/**
 * True means the value must never reach subprocess argv, output, or Git config.
 * Opaque `scheme:...@...` forms fail closed; URL() accepts those but exposes no
 * username/password fields, which is precisely the class that escaped the old flow.
 */
export function hasCloneCredentials(value) {
    if (NAMED_SECRET_TEST_RE.test(value))
        return true;
    if (SCP_REMOTE_RE.test(value))
        return false;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase();
    if (scheme && !value.toLowerCase().startsWith(`${scheme}://`) && scheme !== 'file') {
        return value.includes('@');
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'ssh:' || parsed.protocol === 'git+ssh:') {
            return parsed.password.length > 0;
        }
        return parsed.username.length > 0 || parsed.password.length > 0;
    }
    catch {
        return /[^/\s:@]+:[^@\s/]+@/.test(value);
    }
}
//# sourceMappingURL=clone-security.js.map