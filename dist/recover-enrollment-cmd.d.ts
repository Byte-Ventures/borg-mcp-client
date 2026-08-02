export interface RecoverEnrollmentFlags {
    host?: string;
    yes: boolean;
}
export declare function parseRecoverEnrollmentArgs(argv: string[]): {
    ok: true;
    flags: RecoverEnrollmentFlags;
} | {
    ok: false;
    error: string;
};
export declare function runRecoverEnrollment(flags: RecoverEnrollmentFlags, deps: {
    prompt: (message: string) => Promise<string>;
    stderr: (line: string) => void;
    stdout: (line: string) => void;
}): Promise<number>;
//# sourceMappingURL=recover-enrollment-cmd.d.ts.map