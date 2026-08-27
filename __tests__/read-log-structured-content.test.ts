import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { buildReadLogStructuredContent } from '../src/index';
import { TOOL_MANIFEST } from '../src/tool-manifest';

// gh#496: the unread drain runs on every wake, so its structured payload must
// stay proportional to the entries it returns — no fixed roster block. The
// pre-fix payload shipped the full drones+roles arrays (~54KB even for an
// empty drain).
describe('borg_read-log structured payload proportionality', () => {
  const readLogSchema = TOOL_MANIFEST.find((entry) => entry.name === 'borg_read-log')!.outputSchema!;
  const validator = new AjvJsonSchemaValidator();
  const validate = validator.getValidator(readLogSchema as never);

  const sampleEntry = {
    id: 'e6b8f0a2-1111-4222-8333-444455556666',
    cube_id: 'e6b8f0a2-7777-4888-8999-000011112222',
    drone_id: 'e6b8f0a2-3333-4444-8555-666677778888',
    message: 'DONE server#313 — no server change needed.',
    visibility: 'direct',
    created_at: '2026-08-18T18:00:00.000Z',
    drone_label: 'builder-23d2e2f1',
    role_name: 'Builder',
    recipient_drone_ids: ['e6b8f0a2-9999-4aaa-8bbb-ccccddddeeee'],
  };

  it('bounds an empty drain to a fixed-size, three-key payload', () => {
    const empty = buildReadLogStructuredContent({ entries: [], behind_by: 0, has_more: false });
    expect(Object.keys(empty).sort()).toEqual(['behind_by', 'entries', 'has_more']);
    expect(JSON.stringify(empty).length).toBeLessThan(100);
    const verdict = validate(empty);
    expect(verdict.valid, verdict.errorMessage).toBe(true);
  });

  it('grows only with the entries it returns', () => {
    const one = buildReadLogStructuredContent({ entries: [sampleEntry], behind_by: 2, has_more: true });
    const empty = buildReadLogStructuredContent({ entries: [], behind_by: 2, has_more: true });
    const overhead = JSON.stringify(one).length - JSON.stringify(empty).length - JSON.stringify([sampleEntry]).length;
    expect(Math.abs(overhead)).toBeLessThan(10);
    const verdict = validate(one);
    expect(verdict.valid, verdict.errorMessage).toBe(true);
  });

  it('preserves the cursor-loop semantics for entries, behind_by, and has_more', () => {
    const result = buildReadLogStructuredContent({ entries: [sampleEntry], behind_by: undefined, has_more: undefined });
    expect(result.entries).toEqual([sampleEntry]);
    expect(result.behind_by).toBeNull();
    expect(result.has_more).toBe(false);
    expect(buildReadLogStructuredContent({ entries: [], behind_by: 3, has_more: true })).toMatchObject({
      behind_by: 3,
      has_more: true,
    });
  });

  it('includes omitted only for digest output', () => {
    expect(buildReadLogStructuredContent({
      entries: [sampleEntry],
      behind_by: 0,
      has_more: false,
      omitted: 26,
    })).toMatchObject({ omitted: 26 });
    expect(buildReadLogStructuredContent({
      entries: [],
      behind_by: 0,
      has_more: false,
    })).not.toHaveProperty('omitted');
    expect(readLogSchema.properties).toHaveProperty('omitted');
    expect(readLogSchema.required).not.toContain('omitted');
  });

  it('declares no roster block in the borg_read-log outputSchema', () => {
    expect(readLogSchema.properties).not.toHaveProperty('drones');
    expect(readLogSchema.properties).not.toHaveProperty('roles');
    expect(readLogSchema.required).toEqual(expect.arrayContaining(['entries', 'behind_by', 'has_more']));
  });
});
