export const CUBE_ACTIVITY_RESUME_WAKE_MESSAGE = 'Borg cube activity arrived while you were busy. Reading cube messages does not end your current task. Drain `borg_read-log unread_only=true` until caught up, handle actionable entries, then RESUME the interrupted work.';
export function formatCubeActivityWakeMessage(detail) {
    return `${CUBE_ACTIVITY_RESUME_WAKE_MESSAGE}\n${detail}`;
}
//# sourceMappingURL=cube-activity-wake-copy.js.map