import { describe, expect, it } from 'vitest';
import {
  buildRuntimeMetadataPatch,
  buildRuntimeMetadataReport,
} from '../src/runtime-metadata.js';

describe('runtime metadata collection', () => {
  it('builds the exact full attach report from known safe facts', () => {
    expect(buildRuntimeMetadataReport({
      agentKind: 'opencode',
      reportedModel: 'openai/gpt-5.6-sol',
      workingRepo: {
        name: 'Byte-Ventures/borg-mcp-client',
        origin: 'git@github.com:Byte-Ventures/borg-mcp-client.git',
        state: 'known',
      },
    })).toEqual({
      agent_kind: 'opencode',
      reported_model: 'openai/gpt-5.6-sol',
      working_repo_name: 'Byte-Ventures/borg-mcp-client',
      working_repo_origin: 'https://github.com/Byte-Ventures/borg-mcp-client',
    });
  });

  it('uses explicit nulls in attach reports when facts are unknown or rejected', () => {
    expect(buildRuntimeMetadataReport({
      agentKind: null,
      reportedModel: 'unsafe model\u001b[2J',
      workingRepo: { name: null, origin: null, state: 'rejected' },
    })).toEqual({
      agent_kind: null,
      reported_model: null,
      working_repo_name: null,
      working_repo_origin: null,
    });
  });

  it('omits rejected model and repository values from self-heal patches', () => {
    expect(buildRuntimeMetadataPatch({
      agentKind: 'claude',
      reportedModel: 'unsafe model',
      workingRepo: {
        name: 'owner/repo',
        origin: 'https://user:secret@github.com/owner/repo?token=secret',
      },
    })).toEqual({ agent_kind: 'claude' });
  });

  it('emits an atomic explicit-null repository pair when detection completed unknown', () => {
    expect(buildRuntimeMetadataPatch({
      agentKind: null,
      workingRepo: { name: null, origin: null, state: 'unknown' },
    })).toEqual({
      agent_kind: null,
      working_repo_name: null,
      working_repo_origin: null,
    });
  });
});
