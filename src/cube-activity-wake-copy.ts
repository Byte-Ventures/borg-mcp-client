export const CUBE_ACTIVITY_RESUME_WAKE_MESSAGE =
  'Borg cube activity arrived while you were busy.\n1. Drain `borg_read-log unread_only=true` until caught up.\n2. Peer `ARRIVAL:` and `READY`-only entries are lifecycle-only and non-actionable. Do not reply to them.\n3. Resume interrupted or assigned work.\n4. If none remains, do not run a full regen. Make no reply/status/liveness `borg_log`. Wait.';

export function formatCubeActivityWakeMessage(detail: string): string {
  return `${CUBE_ACTIVITY_RESUME_WAKE_MESSAGE}\n${detail}`;
}
