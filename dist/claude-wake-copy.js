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
export const CLAUDE_MONITOR_LOOP_FALLBACK = 'If the Monitor cannot be armed (a permission request blocks, denies or times out the Monitor call): ' +
    'do not stop and do not wait for the operator. Invoke `/loop` with no arguments. ' +
    'On every loop tick: re-arm the Monitor, then drain `borg_read-log unread_only=true`. ' +
    'While a Monitor is armed, the loop is only a fallback heartbeat.';
//# sourceMappingURL=claude-wake-copy.js.map