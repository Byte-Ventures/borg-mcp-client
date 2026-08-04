import { CUBE_ACTIVITY_RESUME_WAKE_MESSAGE } from './cube-activity-wake-copy.js';
export const OPENCODE_WAKE_PATH_GUIDANCE = 'OpenCode wakes through HTTP entry injection into its session through the local HTTP API. ' +
    'Borg writes each entry to the durable inbox before one injection attempt and ' +
    'confirms delivery by the unique persisted entry text; no inbox Monitor or secondary wake loop is used. ' +
    'If injection is rejected or cannot be ' +
    'confirmed, the durable entry remains available and `borg_stream-status` reports ' +
    'it as failed or delivered-unconfirmed; run `borg_read-log unread_only=true` and ' +
    'drain the unread log to recover. ' +
    CUBE_ACTIVITY_RESUME_WAKE_MESSAGE;
//# sourceMappingURL=opencode-wake-copy.js.map