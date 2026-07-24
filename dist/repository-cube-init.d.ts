import type { CreateCubeRepository, CreateCubeResponse, CubeTemplate } from 'borgmcp-shared/protocol';
import type { GitRepositoryContext, RepositoryAssociation } from './repository-identity.js';
export interface RepositoryCubeDetail {
    id: string;
    name: string;
    roles: any[];
    drones?: Array<{
        role_id: string;
    }>;
}
export interface RepositoryCubeCreation {
    response: CreateCubeResponse;
    cube: RepositoryCubeDetail;
}
export interface RepositoryCubeInitFlags {
    cubeName?: string;
    template?: string;
    noTemplate?: boolean;
    yes?: boolean;
}
export interface RepositoryCubeInitDeps {
    isTTY(): boolean;
    prompt(message: string): Promise<string>;
    write(text: string): void;
    getIdentity(context: GitRepositoryContext): Promise<CreateCubeRepository>;
    getAssociation(repository: CreateCubeRepository): Promise<RepositoryAssociation | null>;
    saveAssociation(repository: CreateCubeRepository, association: RepositoryAssociation): Promise<void>;
    getCube(cubeId: string): Promise<RepositoryCubeDetail>;
    createCube(input: {
        name: string;
        workingRepoName: string;
        repository: CreateCubeRepository;
        template: Exclude<CubeTemplate, 'default'>;
    }): Promise<RepositoryCubeCreation>;
}
export type RepositoryCubeInitResult = {
    kind: 'success';
    creation: RepositoryCubeCreation;
    existing: boolean;
} | {
    kind: 'stop';
    code: number;
};
export declare class RepositoryAssociationSaveError extends Error {
    constructor();
}
export declare function validRepositoryCubeName(value: string): boolean;
export declare function initializeRepositoryCube(input: {
    mode: 'assimilate' | 'cube-init';
    context: GitRepositoryContext;
    serverOrigin: string;
    flags: RepositoryCubeInitFlags;
}, deps: RepositoryCubeInitDeps): Promise<RepositoryCubeInitResult>;
//# sourceMappingURL=repository-cube-init.d.ts.map