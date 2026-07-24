import type { AgentKind, DroneRuntimeMetadata, DroneRuntimeMetadataPatch } from 'borgmcp-shared/protocol';
import type { WorkingRepo } from './working-repo.js';
export declare function buildRuntimeMetadataReport(input: {
    agentKind: AgentKind | null | undefined;
    reportedModel?: string | null;
    workingRepo?: WorkingRepo;
}): DroneRuntimeMetadata;
export declare function buildRuntimeMetadataPatch(input: {
    agentKind: AgentKind | null;
    reportedModel?: string;
    workingRepo?: WorkingRepo;
}): DroneRuntimeMetadataPatch;
//# sourceMappingURL=runtime-metadata.d.ts.map