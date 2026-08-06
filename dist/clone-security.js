/** Redaction helpers for untrusted clone arguments and Git diagnostics. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;
const URL_QUERY_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s?#)]+)([?#])[^\s)]*/gi;
const NAMED_QUERY_SECRET_RE = /([?&](?:access[_-]?token|api[_-]?key|auth(?:entication)?|credential|password|passwd|private[_-]?key|secret|token)=)[^&#\s)]+/gi;
const OPTION_SECRET_RE = /((?:^|[\s("'`])--(?:access[_-]?token|api[_-]?key|auth(?:entication)?|credential|password|passwd|private[_-]?key|secret|token)=)[^\s)]*/gi;
const SCP_USERINFO_RE = /(^|[\s("'`])([^/\s:@]+):([^@\s/]+)@(?=[^/\s:]+:)/g;
const SCP_USERINFO_TEST_RE = /(^|[\s("'`])([^/\s:@]+):([^@\s/]+)@(?=[^/\s:]+:)/;
const SCP_REMOTE_RE = /^[^@\s/:]+@[^:\s]+:[^\s]+$/;
const WINDOWS_PATH_RE = /^[a-z]:[\\/]/i;
/**
 * Remove credentials from values that may be echoed by the parser or Git.
 * Query/fragment data is hidden wholesale because Git may follow a redirect
 * and include a credential under a parameter name we do not know in advance.
 */
export function redactCloneSecrets(value) {
    return value
        .replace(URL_USERINFO_RE, (match, prefix, userInfo) => {
        const scheme = prefix.slice(0, -3).toLowerCase();
        return (scheme === 'ssh' || scheme === 'git+ssh') && !userInfo.includes(':')
            ? match
            : `${prefix}<credentials>@`;
    })
        .replace(URL_QUERY_RE, '$1$2<redacted>')
        .replace(NAMED_QUERY_SECRET_RE, '$1<redacted>')
        .replace(OPTION_SECRET_RE, '$1<redacted>')
        .replace(SCP_USERINFO_RE, '$1<credentials>@');
}
/** Detect URL userinfo, including malformed Git remote forms. */
export function hasCloneCredentials(value) {
    if (SCP_USERINFO_TEST_RE.test(value))
        return true;
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'ssh:' || parsed.protocol === 'git+ssh:') {
            return parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0;
        }
        return parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0;
    }
    catch {
        // Local paths and valid SCP remotes are non-URL inputs. Any other
        // colon/at-sign-bearing value is remote-like but unparseable, so fail
        // closed rather than assuming it carries no credential.
        return !SCP_REMOTE_RE.test(value) && !WINDOWS_PATH_RE.test(value) && /[:@]/.test(value);
    }
}
//# sourceMappingURL=clone-security.js.map