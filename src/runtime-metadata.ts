import type {
  AgentKind,
  DroneRuntimeMetadata,
  DroneRuntimeMetadataPatch,
} from 'borgmcp-shared/protocol';
import {
  canonicalizeRepositoryIdentity,
  validateReportedModel,
  validateRuntimeMetadata,
  validateRuntimeMetadataPatch,
} from 'borgmcp-shared/runtime-metadata';
import type { WorkingRepo } from './working-repo.js';

function safeReportedModel(value: string | null | undefined): string | null {
  if (value == null) return null;
  try {
    return validateReportedModel(value);
  } catch {
    return null;
  }
}

function reportableRepository(repo: WorkingRepo | undefined) {
  if (!repo || repo.state === 'unavailable' || repo.state === 'rejected') return null;
  if (repo.name === null && repo.origin === null) {
    return { working_repo_name: null, working_repo_origin: null };
  }
  if (repo.name === null || repo.origin === null) return null;
  try {
    const canonical = canonicalizeRepositoryIdentity(repo.origin, repo.name);
    return {
      working_repo_name: canonical.working_repo_name,
      working_repo_origin: canonical.working_repo_origin,
    };
  } catch {
    return null;
  }
}

export function buildRuntimeMetadataReport(input: {
  agentKind: AgentKind | null | undefined;
  reportedModel?: string | null;
  workingRepo?: WorkingRepo;
}): DroneRuntimeMetadata {
  const repository = reportableRepository(input.workingRepo);
  return validateRuntimeMetadata({
    agent_kind: input.agentKind ?? null,
    reported_model: safeReportedModel(input.reportedModel),
    working_repo_name: repository?.working_repo_name ?? null,
    working_repo_origin: repository?.working_repo_origin ?? null,
  });
}

export function buildRuntimeMetadataPatch(input: {
  agentKind: AgentKind | null;
  reportedModel?: string;
  workingRepo?: WorkingRepo;
}): DroneRuntimeMetadataPatch {
  const patch: DroneRuntimeMetadataPatch = { agent_kind: input.agentKind };
  if (input.reportedModel !== undefined) {
    const model = safeReportedModel(input.reportedModel);
    if (model !== null) patch.reported_model = model;
  }
  const repository = reportableRepository(input.workingRepo);
  if (repository) Object.assign(patch, repository);
  return validateRuntimeMetadataPatch(patch);
}
