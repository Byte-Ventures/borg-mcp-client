import { describe, expect, it } from 'vitest';
import { rawCubeSettingsResult } from '../src/cube-read-result.js';

const RAW_DIRECTIVE = '# Directive\r\n\r\n## Roles in this cube\nkeep trailing spaces  \n';
const CUBE_ID = '11111111-1111-4111-8111-111111111111';

describe('borg_read-cube result', () => {
  it('returns the stored directive byte-for-byte without generated framing', () => {
    const result = rawCubeSettingsResult({
      id: CUBE_ID,
      name: 'test-cube',
      cube_directive: RAW_DIRECTIVE,
      message_taxonomy: [{ class: 'dispatch', prefixes: ['START:'] }],
    });

    expect(result.content).toEqual([{ type: 'text', text: RAW_DIRECTIVE }]);
    expect(result.structuredContent).toEqual({
      cube_id: CUBE_ID,
      cube_name: 'test-cube',
      cube_directive: RAW_DIRECTIVE,
      message_taxonomy: [{ class: 'dispatch', prefixes: ['START:'] }],
    });
  });

  it('preserves an empty directive and null taxonomy without adding fallback text', () => {
    const result = rawCubeSettingsResult({
      id: CUBE_ID,
      name: 'test-cube',
      cube_directive: '',
      message_taxonomy: null,
    });

    expect(result.content).toEqual([{ type: 'text', text: '' }]);
    expect(result.structuredContent.cube_directive).toBe('');
    expect(result.structuredContent.message_taxonomy).toBeNull();
  });
});
