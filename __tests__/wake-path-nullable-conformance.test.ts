import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { TOOL_MANIFEST } from '../src/tool-manifest';

// gh#500: inspectWakePath().healthy is boolean | null (indeterminate = null).
// The structuredContent fields it feeds must accept null, or a host that
// validates structuredContent against the declared outputSchema rejects the
// real result. Validate the exact indeterminate-health emit for both tools.
describe('wake-path health structuredContent conformance', () => {
  const validator = new AjvJsonSchemaValidator();
  const byName = new Map(TOOL_MANIFEST.map((t) => [t.name, t]));

  it('borg_stream-status accepts inbox_monitor_healthy: null', () => {
    const schema = byName.get('borg_stream-status')!.outputSchema!;
    expect(schema.properties.inbox_monitor_healthy.type).toEqual(['boolean', 'null']);
    const validate = validator.getValidator(schema as never);
    const emitted = {
      status: { connected: false, runLoopHealth: 'never-started' },
      wake_path: { agentKind: 'claude', healthy: null },
      inbox_monitor_healthy: null,
      inbox_path: null, monitor_state_root: null, drone_label: null, cube_name: null,
    };
    const r = validate(emitted);
    expect(r.valid, r.errorMessage).toBe(true);
    // A real boolean must still conform.
    expect(validate({ ...emitted, inbox_monitor_healthy: true }).valid).toBe(true);
  });

  it('borg_regen accepts wake_path_healthy: null on the connected path', () => {
    const schema = byName.get('borg_regen')!.outputSchema!;
    expect(schema.properties.wake_path_healthy.type).toEqual(['boolean', 'null']);
    const validate = validator.getValidator(schema as never);
    const emitted = {
      connected: true,
      mode: 'full',
      cube: { id: 'e6b8f0a2-1111-4222-8333-444455556666', name: 'borg-mcp' },
      drone: { id: 'e6b8f0a2-2222-4333-8444-555566667777', label: 'builder-1' },
      role: { id: 'e6b8f0a2-3333-4444-8555-666677778888', name: 'Builder' },
      behind_by: null,
      decision_topics: [],
      running_version: '4.2.2',
      on_disk_version: null,
      wake_path_healthy: null,
    };
    const r = validate(emitted);
    expect(r.valid, r.errorMessage).toBe(true);
    expect(validate({ ...emitted, wake_path_healthy: false }).valid).toBe(true);
  });

  it('no other tool declares a strict scalar it could emit as null (gh#500 sweep)', () => {
    // The wake-path health fields are the only handler-computed strict scalars
    // that can be null; this pins that the sweep found no others by requiring
    // every remaining strict-scalar output property to be non-nullable by
    // construction in its handler (documented here as the audited allowlist).
    const nullableStrictScalars = new Set([
      'borg_stream-status:inbox_monitor_healthy',
      'borg_regen:wake_path_healthy',
    ]);
    for (const t of TOOL_MANIFEST) {
      if (!t.outputSchema) continue;
      for (const [k, v] of Object.entries(t.outputSchema.properties)) {
        if (v && (v.type === 'boolean' || v.type === 'number')) {
          // Strict scalar remaining after the fix — must be one we audited as
          // non-null, i.e. NOT in the nullable set (those are now ['x','null']).
          expect(nullableStrictScalars.has(`${t.name}:${k}`)).toBe(false);
        }
      }
    }
  });
});
