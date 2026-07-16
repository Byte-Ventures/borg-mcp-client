import { roleSlug } from './role-resolver.js';

export interface LocalRoutingDrone {
  id: string;
  label?: string | null;
  role_id?: string | null;
}

export interface LocalRoutingRole {
  id: string;
  name: string;
  is_human_seat?: boolean;
}

/**
 * Resolve the public `borg_log to:` addressing forms against the local
 * server's authoritative cube roster. This intentionally mirrors the hosted
 * route resolver: exact drone id/label first, then displayed short UUID, then
 * role name/slug expansion. Every failure is closed before the log POST so a
 * miss can never degrade into a broadcast.
 */
export function resolveLocalLogRecipients(
  recipients: readonly string[],
  drones: readonly LocalRoutingDrone[],
  roles: readonly LocalRoutingRole[],
): string[] {
  const ids = new Set<string>();

  for (const recipient of recipients) {
    if (recipient === '@human-seat') {
      const roleIds = new Set(
        roles.filter((role) => role.is_human_seat === true).map((role) => role.id),
      );
      const matches = drones.filter((drone) =>
        drone.role_id !== null && drone.role_id !== undefined && roleIds.has(drone.role_id)
      );
      if (roleIds.size === 0 || matches.length === 0) {
        throw new Error(
          'Direct-message role recipient has no active drones: @human-seat. ' +
          'Use borg_roster to find active recipients, or omit to broadcast if your role can broadcast.',
        );
      }
      for (const drone of matches) ids.add(drone.id);
      continue;
    }

    const droneMatches = drones.filter(
      (drone) => drone.id === recipient || drone.label === recipient,
    );
    const uniqueDroneIds = [...new Set(droneMatches.map((drone) => drone.id))];
    if (uniqueDroneIds.length > 1) {
      throw new Error(
        `Ambiguous direct-message recipient: ${recipient} matches multiple drones`,
      );
    }
    if (uniqueDroneIds.length === 1) {
      ids.add(uniqueDroneIds[0]!);
      continue;
    }

    const shortUuid = recipient.replace(/`/g, '').replace(/^id:/i, '').toLowerCase();
    if (/^[0-9a-f]{8,}$/.test(shortUuid)) {
      const prefixMatches = drones.filter((drone) =>
        drone.id.toLowerCase().startsWith(shortUuid)
      );
      const uniquePrefixIds = [...new Set(prefixMatches.map((drone) => drone.id))];
      if (uniquePrefixIds.length > 1) {
        const listed = prefixMatches
          .map((drone) => `${drone.id} (${drone.label ?? 'unlabeled'})`)
          .join(', ');
        throw new Error(
          `Ambiguous short-uuid recipient: ${recipient} matches multiple drones — ${listed}. ` +
          'Address by the full drone id.',
        );
      }
      if (uniquePrefixIds.length === 1) {
        ids.add(uniquePrefixIds[0]!);
        continue;
      }
    }

    const roleMatches = roles.filter((role) => roleSlug(role.name) === roleSlug(recipient));
    const uniqueRoleIds = [...new Set(roleMatches.map((role) => role.id))];
    if (uniqueRoleIds.length > 1) {
      throw new Error(
        `Ambiguous direct-message recipient: ${recipient} matches multiple roles`,
      );
    }
    if (uniqueRoleIds.length === 0) {
      throw new Error(
        `Unknown direct-message recipient: ${recipient}. ` +
        'Use an exact drone label, drone id, role name, or role slug.',
      );
    }
    const roleDrones = drones.filter((drone) => drone.role_id === uniqueRoleIds[0]);
    if (roleDrones.length === 0) {
      throw new Error(
        `Direct-message role recipient has no active drones: ${recipient}. ` +
        'Use borg_roster to find active recipients, or omit to broadcast if your role can broadcast.',
      );
    }
    for (const drone of roleDrones) ids.add(drone.id);
  }

  return [...ids];
}
