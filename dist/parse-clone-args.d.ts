/** Pure argument parsing for `borg clone <repo-url>`. */
export interface CloneFlags {
    destination?: string;
    name?: string;
    branch?: string;
    noLaunch: boolean;
}
export interface CloneArgs {
    repositoryUrl: string;
    flags: CloneFlags;
}
export type ParseCloneResult = {
    ok: true;
    args: CloneArgs;
} | {
    ok: false;
    error: string;
};
/** Parse clone args without touching the filesystem or spawning Git. */
export declare function parseCloneArgs(rawArgs: readonly string[]): ParseCloneResult;
//# sourceMappingURL=parse-clone-args.d.ts.map