import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOL_MANIFEST } from '../src/tool-manifest';
const clientEntrySource = readFileSync(
  fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  'utf8',
);


/**
 * gh#docs-site — the auto-generated /docs/tools page renders TOOL_MANIFEST, and
 * index.ts registers the SAME array as the tools it serves. These tests pin that
 * the manifest is non-vacuous + well-formed so the published reference can't
 * silently go empty or drift (the gh#740 drift lesson), and that it surfaces
 * only public borg_* tools (the SR gate for the static docs).
 */
describe('TOOL_MANIFEST — source-of-truth tool reference', () => {
  it('is non-vacuous; every entry is a well-formed borg_* tool', () => {
    expect(TOOL_MANIFEST.length).toBeGreaterThan(30);
    for (const t of TOOL_MANIFEST) {
      expect(t.name).toMatch(/^borg_/);
      expect(typeof t.description).toBe('string');
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.inputSchema?.type).toBe('object');
    }
  });

  it('includes the core coordination tools (catches an accidental drop)', () => {
    const names = new Set(TOOL_MANIFEST.map((t) => t.name));
    for (const required of [
      'borg_regen',
      'borg_assimilate',
      'borg_log',
      'borg_read-log',
      'borg_ack',
      'borg_decide',
      'borg_remove-decision',
      'borg_decisions',
      'borg_roster',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('has unique tool names (no duplicate entries)', () => {
    const names = TOOL_MANIFEST.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('surfaces no internal-only / debug / admin tools (SR — public docs)', () => {
    for (const t of TOOL_MANIFEST) {
      expect(t.name).not.toMatch(/internal|debug|admin|secret|__/i);
    }
  });

  it('borg_role declares an optional role argument', () => {
    const tool = TOOL_MANIFEST.find((t: any) => t.name === 'borg_role');
    expect(tool.inputSchema.properties).toHaveProperty('role');
    expect(tool.inputSchema.required ?? []).not.toContain('role');
    expect(tool.description).not.toMatch(/Other drones cannot see this/);
  });

  it('borg_regen declares its optional advisory model self-report', () => {
    const tool = TOOL_MANIFEST.find((t: any) => t.name === 'borg_regen');
    expect(tool.inputSchema.properties).toHaveProperty('model');
    expect(tool.inputSchema.required ?? []).not.toContain('model');
  });

  it('borg_remove-decision exposes its exactly-one selector contract', () => {
    const tool = TOOL_MANIFEST.find((entry) => entry.name === 'borg_remove-decision');
    expect(tool?.inputSchema.oneOf).toEqual([{ required: ['topic'] }, { required: ['decision_id'] }]);
    expect(tool?.inputSchema.properties).toHaveProperty('topic');
    expect(tool?.inputSchema.properties).toHaveProperty('decision_id');
  });

  it('role tools do not advertise retired model selection (gh#1019)', () => {
    for (const toolName of ['borg_create-role', 'borg_update-role']) {
      const tool = TOOL_MANIFEST.find((entry) => entry.name === toolName);
      expect(tool, `${toolName} must remain in the canonical manifest`).toBeDefined();
      expect(tool!.inputSchema.properties).not.toHaveProperty('default_model');
      expect(JSON.stringify(tool!.inputSchema)).not.toMatch(/ollama/i);
    }
  });

  it('empty role updates do not recommend retired model selection (gh#1019)', () => {
    const errorCopy = [...clientEntrySource.matchAll(/Pass at least one of:[^']+/g)]
      .map((match) => match[0])
      .find((copy) => copy.includes('short_description'));
    expect(errorCopy, 'borg_update-role must retain actionable empty-update guidance').toBeDefined();
    expect(errorCopy).not.toContain('default_model');
  });

});
