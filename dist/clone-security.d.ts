/** Redaction helpers for untrusted clone arguments and Git diagnostics. */
/**
 * Remove credentials from values that may be echoed by the parser or Git.
 * Query/fragment data is hidden wholesale because Git may follow a redirect
 * and include a credential under a parameter name we do not know in advance.
 */
export declare function redactCloneSecrets(value: string): string;
/** Detect URL userinfo, including malformed Git remote forms. */
export declare function hasCloneCredentials(value: string): boolean;
//# sourceMappingURL=clone-security.d.ts.map