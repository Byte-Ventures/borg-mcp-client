/**
 * Pure label→id resolution for the `borg_evict-drone` tool (gh#718).
 *
 * `CubeStore.evictDrone` and the owner-authed `DELETE /api/drones/:id` route
 * both take a drone UUID. Coordinators, however, see drone LABELS everywhere
 * (roster, regen, cube log) and rarely the UUIDs. This helper lets the tool
 * accept a label and resolve it to the drone id client-side, against the
 * owner-scoped cube detail returned by `getCube` (the same id+label pairs
 * `borg_list-drones` renders). No I/O here — a pure function so it can be
 * unit-tested in isolation; the handler in index.ts owns the network calls.
 */

export interface EvictableDrone {
  id: string;
  label: string;
}

/**
 * Strict whole-string UUID shape check for the `drone_id` input (gh#782).
 * The handler rejects non-UUID values before building the DELETE URL: a
 * label passed as drone_id gets a clear "use label + cube_id" hint instead
 * of a confusing 404, and a path-shaped value ("../cubes/<uuid>") is never
 * interpolated into a request path. Case-insensitive; anchored so embedded
 * or suffixed UUIDs do not pass.
 */
export function isUuidShape(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Assert-style wrapper around isUuidShape (gh#782, reassign half). Called
 * by the remote-client functions that interpolate a drone id into the
 * request path (reassignDrone PATCH, evictDrone DELETE) — FIRST, before
 * any token fetch or network I/O, so a path-shaped value like
 * "../cubes/<uuid>" can never reach URL construction. The `label` names
 * the offending input in the caller-facing error.
 */
export function assertUuidShape(value: string, label: string): void {
  if (!isUuidShape(value)) {
    throw new Error(`${label} "${value}" is not a UUID`);
  }
}

/**
 * Resolve an exact drone label to its `{ id, label }` within a single cube's
 * drone list. Labels are unique per cube, so an exact match is unambiguous.
 * Returns null when no drone carries the label (the handler turns that into a
 * caller-facing error). Matching is exact (not substring) and label-only — a
 * UUID passed here never resolves, because the handler routes UUIDs through the
 * explicit `drone_id` input instead.
 */
export function resolveDroneIdByLabel(
  drones: ReadonlyArray<EvictableDrone>,
  label: string
): EvictableDrone | null {
  const target = label.trim();
  const match = drones.find((d) => d.label === target);
  return match ? { id: match.id, label: match.label } : null;
}
