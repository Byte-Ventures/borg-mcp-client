# Agent Session Identity

ARRIVAL is announced once for each known agent session and cube/drone pair, using local lifecycle state. Changing the ARRIVAL wording or reconnecting the MCP transport does not create another announcement for that identity. A different session announces immediately, without a time window. Resuming an already announced session remains suppressed. This state does not affect credentials, authorization, stream ownership, or liveness.

The startup instruction itself remains process-local: reconnecting may display it again. Calling `borg_log` with ARRIVAL applies the persistent identity check. Unknown identity always announces rather than concealing a possible restart. READY suppression is unchanged.

## Harness Coverage

- **Claude Code:** the latest SessionStart hook observed for this launch. Borg puts a random correlation in the launch environment. `borg-regen` stores that correlation, the hook's `session_id`, and its observation time in the worktree's `.borgmcp/claude-session.json`. A reconnect with the same correlation reads the same observation; a successful hook on resume replaces it. Missing, invalid, unreadable, or prior-launch state is unknown. Claude identity can be stale after a resume whose SessionStart hook failed.
- **Codex:** exactly one non-ephemeral user thread, excluding subagents, in this launch's Borg-owned app-server. Zero or multiple candidates, an unreadable thread, or an unavailable socket is unknown. No recency guess identifies a session.
- **OpenCode:** the existing launch-correlation binding, rechecked against session metadata. Missing or changed binding, an unseen root session, duplicated launch metadata, or failed inspection is unknown. The identity reader does not follow the wake injector's `/new` selection heuristic.

`borg_stream-status` reports the identity source, the harness-prefixed session id, and the age of the observation in its text response. For Claude this age is measured from the hook, not the MCP child's start. Age is diagnostic only: there is no expiry heuristic. For Codex and OpenCode the observation is a fresh query. Unknown results report their reason.

These identifiers denote harness conversations, not operating-system processes. Restarting a harness into a new conversation produces a new identity; explicitly resuming the same conversation retains its identity when ownership is known. Session identifiers are not secrets or authorization inputs.
