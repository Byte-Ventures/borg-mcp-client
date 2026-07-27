import type { ActiveCube } from './cubes.js';

const LAST_CONFIRMED = ' (last confirmed)';

type DisplayField = {
  value: string | null;
  uncertain: boolean;
};

type DisplayState = {
  seatKey: string;
  cubeName: DisplayField;
  droneLabel: DisplayField;
  roleName: DisplayField;
};

export type DisplayIdentity = {
  cubeName: string;
  droneLabel: string;
  roleName: string | null;
};

export type ServerDisplayIdentity = Partial<DisplayIdentity>;

let state: DisplayState | null = null;

function seatKey(active: Pick<ActiveCube, 'cubeId' | 'droneId'>): string {
  return `${active.cubeId}\0${active.droneId}`;
}

function initialState(active: ActiveCube): DisplayState {
  return {
    seatKey: seatKey(active),
    cubeName: { value: active.name, uncertain: false },
    droneLabel: { value: active.droneLabel, uncertain: false },
    roleName: { value: active.roleName ?? null, uncertain: false },
  };
}

function ensureState(active: ActiveCube): DisplayState {
  const key = seatKey(active);
  if (state === null || state.seatKey !== key) {
    state = initialState(active);
  }
  return state;
}

function confirmField(field: DisplayField, value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  field.value = value;
  field.uncertain = false;
}

function renderField(field: DisplayField): string | null {
  if (field.value === null) return null;
  return field.uncertain ? `${field.value}${LAST_CONFIRMED}` : field.value;
}

/** Seed the invocation-local display source from the exact seat selected by #63. */
export function seedDisplayIdentity(active: ActiveCube): void {
  ensureState(active);
}

/** Apply server-authoritative fields and clear uncertainty only for those fields. */
export function confirmDisplayIdentity(
  active: ActiveCube,
  identity: ServerDisplayIdentity,
): DisplayIdentity {
  const current = ensureState(active);
  confirmField(current.cubeName, identity.cubeName);
  confirmField(current.droneLabel, identity.droneLabel);
  confirmField(current.roleName, identity.roleName);
  return renderDisplayIdentity(active);
}

/** Mark the current seat identity as last-confirmed after an identity read fails. */
export function markDisplayIdentityReadFailed(active: ActiveCube): void {
  const current = ensureState(active);
  current.cubeName.uncertain = true;
  current.droneLabel.uncertain = true;
  if (current.roleName.value !== null) current.roleName.uncertain = true;
}

export function renderDisplayIdentity(active: ActiveCube): DisplayIdentity {
  const current = ensureState(active);
  return {
    cubeName: renderField(current.cubeName)!,
    droneLabel: renderField(current.droneLabel)!,
    roleName: renderField(current.roleName),
  };
}

/** Synchronous view for console-prefix after initConsolePrefix seeds the seat. */
export function currentDisplayIdentity(): DisplayIdentity | null {
  if (state === null) return null;
  return {
    cubeName: renderField(state.cubeName)!,
    droneLabel: renderField(state.droneLabel)!,
    roleName: renderField(state.roleName),
  };
}

export function identityFromRegen(result: {
  cube?: { name?: string | null };
  drone?: { label?: string | null };
  role?: { name?: string | null };
}): ServerDisplayIdentity {
  return {
    cubeName: result.cube?.name ?? undefined,
    droneLabel: result.drone?.label ?? undefined,
    roleName: result.role?.name ?? undefined,
  };
}

export function withRenderedRegenIdentity<T extends {
  cube?: Record<string, unknown>;
  drone?: Record<string, unknown>;
  role?: Record<string, unknown>;
}>(result: T, identity: DisplayIdentity): T {
  return {
    ...result,
    cube: { ...result.cube, name: identity.cubeName },
    drone: { ...result.drone, label: identity.droneLabel },
    role: { ...result.role, name: identity.roleName },
  };
}

export function _resetDisplayIdentityForTests(): void {
  state = null;
}
