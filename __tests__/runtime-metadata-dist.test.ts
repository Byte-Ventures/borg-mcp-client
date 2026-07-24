import { describe, expect, it } from 'vitest';
import * as sourceMetadata from '../src/runtime-metadata.js';
import * as builtMetadata from '../dist/runtime-metadata.js';
import * as sourceAgent from '../src/agent-runtime.js';
import * as builtAgent from '../dist/agent-runtime.js';
import * as sourceRepo from '../src/working-repo.js';
import * as builtRepo from '../dist/working-repo.js';
import * as sourceRoster from '../src/roster-render.js';
import * as builtRoster from '../dist/roster-render.js';

describe('runtime metadata source/dist parity', () => {
  it('keeps detection, canonicalization, payloads, and rendering identical', () => {
    const env = { BORG_AGENT_KIND: 'codex' } as NodeJS.ProcessEnv;
    expect(builtAgent.resolveReportableSessionAgentKind(env))
      .toBe(sourceAgent.resolveReportableSessionAgentKind(env));

    const deps = {
      runGit: (_cwd: string, args: string[]) => args[0] === 'rev-parse'
        ? { status: 0, stdout: '/private/local/path\n' }
        : { status: 0, stdout: 'git@github.com:Byte-Ventures/borg-mcp-client.git\n' },
    };
    const sourceWorkingRepo = sourceRepo.resolveWorkingRepo('/private/local/path', deps);
    const builtWorkingRepo = builtRepo.resolveWorkingRepo('/private/local/path', deps);
    expect(builtWorkingRepo).toEqual(sourceWorkingRepo);

    const input = {
      agentKind: 'codex' as const,
      reportedModel: 'openai/gpt-5.6-sol',
      workingRepo: sourceWorkingRepo,
    };
    expect(builtMetadata.buildRuntimeMetadataReport(input))
      .toEqual(sourceMetadata.buildRuntimeMetadataReport(input));
    expect(builtMetadata.buildRuntimeMetadataPatch(input))
      .toEqual(sourceMetadata.buildRuntimeMetadataPatch(input));

    const drone = {
      label: 'builder-1',
      role_id: 'role-1',
      last_seen: '2026-07-24T00:00:00.000Z',
      runtime_metadata_reported: true,
      ...sourceMetadata.buildRuntimeMetadataReport(input),
    };
    expect(builtRoster.renderRuntimeMetadataLines(drone, { includeOrigin: true }))
      .toEqual(sourceRoster.renderRuntimeMetadataLines(drone, { includeOrigin: true }));
    expect(builtRoster.renderRuntimeMetadataLines({
      ...drone,
      reported_model: 'https://phish.example/model',
      working_repo_name: 'owner/repo',
      working_repo_origin: 'https://phish.example/owner/repo',
    }, { includeOrigin: true })).toEqual([
      '  - **Agent CLI:** Codex',
      '  - **Reported model:** https\\[:]//phish\\[.\\]example/model',
      '  - **Working repo:** owner/repo',
      '  - **Origin:** phish\\[.\\]example/owner/repo',
    ]);
  });
});
