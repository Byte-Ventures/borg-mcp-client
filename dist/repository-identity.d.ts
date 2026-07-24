import type { CreateCubeRepository, CubeTemplate } from 'borgmcp-shared/protocol';
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
    runGit?: (cwd: string, args: string[]) => {
        status: number | null;
        stdout?: string | null;
    };
    canonicalPath?: (path: string) => Promise<string>;
    root?: string;
}
export declare function resolveGitRepositoryContext(cwd: string, deps?: RepositoryIdentityDeps): Promise<GitRepositoryContext | null>;
export declare function getOrCreateRepositoryIdentity(context: GitRepositoryContext, deps?: RepositoryIdentityDeps): Promise<CreateCubeRepository>;
export declare function getRepositoryAssociation(trustIdentity: string, repository: CreateCubeRepository, deps?: RepositoryIdentityDeps): Promise<RepositoryAssociation | null>;
export declare function saveRepositoryAssociation(trustIdentity: string, repository: CreateCubeRepository, association: RepositoryAssociation, deps?: RepositoryIdentityDeps): Promise<void>;
//# sourceMappingURL=repository-identity.d.ts.map