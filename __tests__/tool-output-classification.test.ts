import { describe, expect, it } from 'vitest';
import { TOOL_MANIFEST, TOOL_OUTPUT_SCHEMAS } from '../src/tool-manifest';

/**
 * gh#492: every borg_* tool carries an EXPLICIT structured-output
 * classification. A new tool added without extending one of these lists fails
 * the enumeration test below, so the machine-readable contract can never
 * silently lag the registry.
 */
const TYPED_TOOLS = [
  // Machine-state queries and discovery
  'borg_version',
  'borg_whoami',
  'borg_roster',
  'borg_stream-status',
  'borg_read-log',
  'borg_read-entry',
  'borg_ack-status',
  'borg_decisions',
  'borg_get-document',
  'borg_list-documents',
  'borg_list-cubes',
  'borg_list-drones',
  'borg_list-roles',
  'borg_list-templates',
  'borg_describe-tool',
  // Mutation receipts
  'borg_ack',
  'borg_decide',
  'borg_remove-decision',
  'borg_put-document',
  'borg_remove-document',
  'borg_log',
  'borg_create-cube',
  'borg_update-cube',
  'borg_patch-taxonomy-class',
  'borg_delete-cube',
  'borg_create-role',
  'borg_update-role',
  'borg_patch-role-section',
  'borg_delete-role',
  'borg_reassign-drone',
  'borg_evict-drone',
  'borg_apply-template',
  'borg_sync-roles',
  // Context/domain results
  'borg_regen',
  'borg_assimilate',
  'borg_cube',
  'borg_role',
  'borg_docs',
  'borg_role-rationale',
];

/** Output varies by the selected inner tool; the inner result passes through. */
const DYNAMIC_TOOLS = ['borg_tool'];

/** Deliberate long-form prose; synthetic structure would add nothing. */
const TEXT_ONLY_TOOLS = ['borg_playbook'];

describe('tool output classification — complete registry', () => {
  it('classifies every manifest entry in exactly one category', () => {
    const classified = new Map<string, string>();
    for (const [category, names] of [
      ['typed', TYPED_TOOLS],
      ['dynamic', DYNAMIC_TOOLS],
      ['text-only', TEXT_ONLY_TOOLS],
    ] as const) {
      for (const name of names) {
        expect(classified.has(name), `${name} classified twice`).toBe(false);
        classified.set(name, category);
      }
    }
    for (const entry of TOOL_MANIFEST) {
      expect(
        classified.has(entry.name),
        `${entry.name} has no structured/text-only classification — add it to a list in this test AND (if typed) to TOOL_OUTPUT_SCHEMAS`,
      ).toBe(true);
    }
    const manifestNames = new Set(TOOL_MANIFEST.map((entry) => entry.name));
    for (const name of classified.keys()) {
      expect(manifestNames.has(name), `${name} is classified but not in the manifest`).toBe(true);
    }
    expect(TOOL_MANIFEST.length).toBe(classified.size);
  });

  it('gives every typed tool an outputSchema and no other tool one', () => {
    for (const entry of TOOL_MANIFEST) {
      if (TYPED_TOOLS.includes(entry.name)) {
        expect(entry.outputSchema, `${entry.name} is typed but declares no outputSchema`).toBeDefined();
      } else {
        expect(entry.outputSchema, `${entry.name} is not typed but declares an outputSchema`).toBeUndefined();
      }
    }
    for (const name of Object.keys(TOOL_OUTPUT_SCHEMAS)) {
      expect(TYPED_TOOLS.includes(name), `TOOL_OUTPUT_SCHEMAS has an orphan entry: ${name}`).toBe(true);
    }
  });

  it('declares well-formed, tolerant output schemas', () => {
    for (const entry of TOOL_MANIFEST) {
      if (!entry.outputSchema) continue;
      expect(entry.outputSchema.type).toBe('object');
      expect(entry.outputSchema.properties).toBeTypeOf('object');
      for (const required of entry.outputSchema.required ?? []) {
        expect(
          entry.outputSchema.properties[required],
          `${entry.name}.outputSchema requires undeclared property ${required}`,
        ).toBeDefined();
      }
      // Additive server fields must never invalidate a conforming result.
      expect(JSON.stringify(entry.outputSchema)).not.toContain('"additionalProperties":false');
    }
  });

  it('keeps the high-risk orchestration contracts explicit', () => {
    const byName = new Map(TOOL_MANIFEST.map((entry) => [entry.name, entry]));
    expect(byName.get('borg_ack-status')?.outputSchema?.required).toEqual(
      expect.arrayContaining(['entry_id', 'visibility', 'recipients', 'claims']),
    );
    expect(byName.get('borg_read-log')?.outputSchema?.required).toEqual(
      expect.arrayContaining(['entries', 'behind_by', 'has_more']),
    );
    expect(byName.get('borg_log')?.outputSchema?.required).toEqual(
      expect.arrayContaining(['suppressed', 'entry', 'recipients', 'unreachable_recipients', 'advisory']),
    );
  });
});
