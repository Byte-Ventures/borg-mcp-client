import { describe, expect, it, vi } from 'vitest';
import { getTemplate } from 'borgmcp-shared/templates';
import { runApplyTemplateTool } from '../src/index.js';

const ACTIVE_CUBE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_CUBE_ID = '99999999-9999-4999-8999-999999999999';
const ORIGIN_A = 'https://127.0.0.1:7091';
const ORIGIN_C = 'https://127.0.0.1:7093';

describe('borg_apply-template orchestration authority', () => {
  it('keeps target readback and directive patch on server A after active state swaps to C', async () => {
    const calls: Array<{ operation: string; origin: string; cubeId: string }> = [];
    const active = {
      cubeId: ACTIVE_CUBE_ID,
      droneId: '22222222-2222-4222-8222-222222222222',
      name: 'active',
      sessionToken: 's'.repeat(43),
      apiUrl: ORIGIN_A,
      serverTrustIdentity: 'spki-a',
    };
    const authority = {
      active,
      connection: { apiUrl: ORIGIN_A, authToken: 'manage-a', serverTrustIdentity: 'spki-a' },
    };
    const applyTemplate = vi.fn(async (cubeId: string, _name: string, resolved: typeof authority) => {
      calls.push({ operation: 'apply', origin: resolved.connection.apiUrl, cubeId });
      active.apiUrl = ORIGIN_C;
      return { created: 1, updated: 1 };
    });
    const getCubeForManagement = vi.fn(async (cubeId: string, _operation: unknown, resolved: typeof active, connection: typeof authority.connection) => {
      calls.push({ operation: 'readback', origin: connection.apiUrl, cubeId });
      expect(resolved.apiUrl).toBe(ORIGIN_C);
      return { id: cubeId, name: 'target', cube_directive: '', roles: [], drones: [] };
    });
    const updateCube = vi.fn(async (cubeId: string, _updates: unknown, resolved: typeof active, connection: typeof authority.connection) => {
      calls.push({ operation: 'directive-patch', origin: connection.apiUrl, cubeId });
      expect(resolved.apiUrl).toBe(ORIGIN_C);
      return { cube: { id: cubeId } };
    });

    const result = await runApplyTemplateTool(TARGET_CUBE_ID, getTemplate('software-dev')!, authority, {
      applyTemplate,
      getCubeForManagement,
      updateCube,
    });

    expect(result.summary).toEqual({ created: 1, updated: 1 });
    expect(result.cubeDirectiveNote).toContain('directive applied');
    expect(calls).toEqual([
      { operation: 'apply', origin: ORIGIN_A, cubeId: TARGET_CUBE_ID },
      { operation: 'readback', origin: ORIGIN_A, cubeId: TARGET_CUBE_ID },
      { operation: 'directive-patch', origin: ORIGIN_A, cubeId: TARGET_CUBE_ID },
    ]);
    expect(calls.every((call) => call.origin !== ORIGIN_C)).toBe(true);
  });
});
