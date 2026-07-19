interface ReassignmentResult {
  drone: { id: string; label: string; role_id: string };
  role?: { id: string; name: string };
  cube?: { id: string; name: string };
}

export function formatReassignmentSuccess({ drone, role, cube }: ReassignmentResult): string {
  if (role && cube) {
    return `Reassigned ${drone.label} in cube ${cube.name} to role ${role.name}.\n` +
      `Drone id: ${drone.id}\nRole id: ${role.id}`;
  }

  return `Reassigned drone ${drone.label} (${drone.id}) to role ${drone.role_id}.`;
}

export function formatEvictionSuccess(
  targetLabel: string,
  targetId: string,
  targetCubeName?: string,
): string {
  const removal = targetCubeName
    ? `Removed ${targetLabel} from cube ${targetCubeName}.`
    : `Removed ${targetId} from its cube.`;

  return `${removal}\n` +
    'The seat credential is revoked. The session will stop after its next Borg request.\n' +
    'The worktree and project files were not deleted. Activity history remains attributed to the removed seat.\n' +
    'After its work is merged, run `borg cleanup` to review whether the worktree can be pruned.';
}
