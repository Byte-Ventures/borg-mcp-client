import { type QuickstartArgs } from './parse-quickstart-args.js';
export interface CloneArgs extends QuickstartArgs {
    repositoryUrl: string;
    destination?: string;
    checkoutOnly: boolean;
}
export type ParseCloneResult = {
    ok: true;
    args: CloneArgs;
} | {
    ok: false;
    error: string;
};
export declare function parseCloneArgs(rawArgs: readonly string[]): ParseCloneResult;
export declare function safeCloneParseError(result: Extract<ParseCloneResult, {
    ok: false;
}>): string;
//# sourceMappingURL=parse-clone-args.d.ts.map