import { describe, it, expect } from 'vitest';
import {
  filterToolsForRole,
  deferredToolNames,
  UNIVERSAL_TOOLS,
  MANAGEMENT_TOOLS,
  DISPATCHER_TOOLS,
  AUTH_SENSITIVE_TOOLS,
  type RoleScope,
} from '../src/tool-scope.js';

// gh#899: role-scope the NATIVE tool surface (UX/context optimization only —
// NOT an auth boundary). Workers get the universal set + dispatcher; management
// + billing tools are deferred (reachable via the dispatcher). Management seats
// and an unknown role get the full set (never hide capability).

const WORKER: RoleScope = { roleName: 'Builder', roleClass: 'worker', isHumanSeat: false };
const COORDINATOR: RoleScope = { roleName: 'Coordinator', roleClass: 'worker', isHumanSeat: true };
const QUEEN: RoleScope = { roleName: 'Queen', roleClass: 'queen', isHumanSeat: false };

// A representative full tool list (names only — the real defs live in index.ts).
const ALL = [
  ...UNIVERSAL_TOOLS,
  ...MANAGEMENT_TOOLS,
].map((name) => ({ name }));

describe('tool-scope role filtering (gh#899)', () => {
  it('worker: hides management, keeps universal + dispatcher', () => {
    const names = new Set(filterToolsForRole(ALL, WORKER).map((t) => t.name));
    for (const u of UNIVERSAL_TOOLS) expect(names.has(u)).toBe(true);
    for (const d of DISPATCHER_TOOLS) expect(names.has(d)).toBe(true);
    for (const m of MANAGEMENT_TOOLS) expect(names.has(m)).toBe(false);
  });

  it('worker: auth-sensitive ops are filtered from the native surface', () => {
    const names = new Set(filterToolsForRole(ALL, WORKER).map((t) => t.name));
    for (const s of AUTH_SENSITIVE_TOOLS) expect(names.has(s)).toBe(false);
  });

  it('decision removal is native only for management seats', () => {
    expect(MANAGEMENT_TOOLS).toContain('borg_remove-decision');
    expect(deferredToolNames(WORKER).has('borg_remove-decision')).toBe(true);
    expect(deferredToolNames(COORDINATOR).has('borg_remove-decision')).toBe(false);
  });

  it('human-seat (Coordinator): full set, nothing hidden', () => {
    expect(filterToolsForRole(ALL, COORDINATOR).length).toBe(ALL.length);
    expect(deferredToolNames(COORDINATOR).size).toBe(0);
  });

  it('queen-class: full set, nothing hidden', () => {
    expect(filterToolsForRole(ALL, QUEEN).length).toBe(ALL.length);
    expect(deferredToolNames(QUEEN).size).toBe(0);
  });

  it('unknown role (null scope) → full set (safe default, no capability hidden)', () => {
    expect(filterToolsForRole(ALL, null).length).toBe(ALL.length);
    expect(deferredToolNames(null).size).toBe(0);
  });

  it('unknown role (roleName absent) → full set', () => {
    const noRole: RoleScope = { roleClass: 'worker', isHumanSeat: false };
    expect(filterToolsForRole(ALL, noRole).length).toBe(ALL.length);
    expect(deferredToolNames(noRole).size).toBe(0);
  });

  it('dispatcher tools are always present even for a worker', () => {
    const names = new Set(filterToolsForRole(ALL, WORKER).map((t) => t.name));
    expect(names.has('borg_tool')).toBe(true);
    expect(names.has('borg_describe-tool')).toBe(true);
  });

  it('fail-safe: an unmapped tool name is NEVER hidden (defaults to native)', () => {
    const withUnmapped = [...ALL, { name: 'borg_future-tool' }];
    const names = new Set(filterToolsForRole(withUnmapped, WORKER).map((t) => t.name));
    expect(names.has('borg_future-tool')).toBe(true);
  });

  it('the sets are disjoint and dispatcher ⊂ universal', () => {
    const mgmt = new Set(MANAGEMENT_TOOLS);
    for (const u of UNIVERSAL_TOOLS) {
      expect(mgmt.has(u)).toBe(false);
    }
    for (const d of DISPATCHER_TOOLS) expect(UNIVERSAL_TOOLS.includes(d)).toBe(true);
  });
});
