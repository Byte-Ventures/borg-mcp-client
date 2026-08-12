/** Redaction and fail-closed credential detection for untrusted Git remotes. */
export declare function redactCloneSecrets(value: string): string;
/**
 * True means the value must never reach subprocess argv, output, or Git config.
 * Opaque `scheme:...@...` forms fail closed; URL() accepts those but exposes no
 * username/password fields, which is precisely the class that escaped the old flow.
 */
export declare function hasCloneCredentials(value: string): boolean;
//# sourceMappingURL=clone-security.d.ts.map