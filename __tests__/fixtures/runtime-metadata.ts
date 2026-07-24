export const UNREPORTED_DRONE_RUNTIME_METADATA = {
  agent_kind: null,
  reported_model: null,
  working_repo_name: null,
  working_repo_origin: null,
  runtime_metadata_reported: false,
} as const;

export const UNREPORTED_ATTACH_RUNTIME_METADATA = {
  runtime_metadata: {
    agent_kind: null,
    reported_model: null,
    working_repo_name: null,
    working_repo_origin: null,
  },
  runtime_metadata_reported: false,
} as const;
