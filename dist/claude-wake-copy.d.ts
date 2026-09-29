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
export declare function claudeMonitorCommand(inboxPath: string, monitorStateRoot?: string | null): string;
export declare const CLAUDE_MONITOR_REARM_THEN_DRAIN = "Re-arm the Monitor first, then drain `borg_read-log unread_only=true`.";
export declare const CLAUDE_MONITOR_LOOP_FALLBACK: string;
//# sourceMappingURL=claude-wake-copy.d.ts.map