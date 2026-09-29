import { shellEscape } from './shell-escape.js';
/**
 * The Claude inbox-Monitor wake-path copy, shared by every surface that tells a
 * Claude drone how to arm or recover its Monitor: the lean orientation and
 * launch kickoff (`wakePathArming`), the `borg_regen` wake-path prefix and the
 * `borg_stream-status` self-arm section. Weak models read it, so each line is
 * short and imperative.
 *
 * Order matters: a new Monitor starts at the end of the inbox, so an entry
 * written before it arms is only found by a drain that runs after it arms.
 */
export function claudeMonitorCommand(inboxPath, monitorStateRoot) {
    // client#394: the stable npm bin survives Node/nvm install-path rotation.
    return monitorStateRoot
        ? `borg-inbox-monitor --state-root ${shellEscape(monitorStateRoot)} ${shellEscape(inboxPath)}`
        : `borg-inbox-monitor ${shellEscape(inboxPath)}`;
}
export const CLAUDE_MONITOR_REARM_THEN_DRAIN = 'Re-arm the Monitor first, then drain `borg_read-log unread_only=true`.';
/**
 * The Monitor could not be armed, but nobody refused it: keep re-arming from
 * a `/loop` heartbeat so the seat stays awake. "Drain" is the
 * `borg_read-log unread_only=true` drain every surface names just before this.
 */
export const CLAUDE_MONITOR_LOOP_FALLBACK = 'If a permission prompt blocks the Monitor call, or it times out, gets no classifier verdict or errors: ' +
    'do not stop or wait. Invoke `/loop` with no arguments; each tick, re-arm the Monitor, then drain. ' +
    'With a Monitor armed, the loop is only a fallback.';
/**
 * A human refused the Monitor: never ask again. The seat still stays awake by
 * draining from `/loop`, and says once that it is polling.
 */
export const CLAUDE_MONITOR_DENIED_FALLBACK = 'If a human denies the Monitor call: never request it again. Invoke `/loop` with no arguments; each tick, only drain. ' +
    "Once, `borg_log` your cube's coordinating role: Monitor denied, seat polling via `/loop`.";
//# sourceMappingURL=claude-wake-copy.js.map