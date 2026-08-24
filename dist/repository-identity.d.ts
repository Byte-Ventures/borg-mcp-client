import { type CreateCubeRepository, type CubeTemplate } from 'borgmcp-shared/protocol';
export interface GitRepositoryContext {
    root: string;
    commonDir: string;
    derivedName: string;
    publicRepository: Extract<CreateCubeRepository, {
        kind: 'origin';
    }> | null;
    publicRepositoryName: string | null;
}
export interface RepositoryAssociation {
    cubeId: string;
    name: string;
    workingRepoName: string;
    template: CubeTemplate;
}
export interface RepositoryIdentityDeps {
    runGit?: (cwd: string, args: string[]) => GitCommandResult;
    canonicalPath?: (path: string) => Promise<string>;
    root?: string;
}
interface GitCommandResult {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
    error?: Error;
}
export declare class RepositoryDiscoveryError extends Error {
    readonly kind: 'git-execution' | 'git-query' | 'canonical-path';
    readonly name = "RepositoryDiscoveryError";
    constructor(kind: 'git-execution' | 'git-query' | 'canonical-path', message: string, options?: ErrorOptions);
}
export declare function repositoryDiscoveryFailureMessage(error: unknown): string;
export declare function resolveGitRepositoryContext(cwd: string, deps?: RepositoryIdentityDeps): Promise<GitRepositoryContext | null>;
export declare function getOrCreateRepositoryIdentity(context: GitRepositoryContext, deps?: RepositoryIdentityDeps): Promise<CreateCubeRepository>;
export declare function getRepositoryAssociation(trustIdentity: string, repository: CreateCubeRepository, deps?: RepositoryIdentityDeps): Promise<RepositoryAssociation | null>;
export declare function saveRepositoryAssociation(trustIdentity: string, repository: CreateCubeRepository, association: RepositoryAssociation, deps?: RepositoryIdentityDeps): Promise<void>;
export {};
//# sourceMappingURL=repository-identity.d.ts.map