# src

Contract for `src/` (stored outside `src/` because `src/` is packed to npm).

## Overview

`src/` is the TypeScript source of the npm package `borgmcp`. The directory
is flat (153 modules) and has one subdirectory, `backends/`. `tsc` compiles it
to the tracked `dist/` tree. The `bin` map in `package.json` exposes these
entry points:

| Bin | Entry module | Role |
| --- | --- | --- |
| `borg` | [`claude.ts`](../../src/claude.ts) | Launcher and client CLI |
| `borg-setup` | [`setup.ts`](../../src/setup.ts) | Setup wizard |
| `borg-mcp` | [`index.ts`](../../src/index.ts) | Stdio MCP server that each agent session runs |
| `borg-regen` | [`regen.ts`](../../src/regen.ts) | SessionStart hook (orientation) |
| `borg-clear-rewake` | [`clear-rewake.ts`](../../src/clear-rewake.ts) | SessionStart hook for `/clear` |
| `borg-log-audit` | [`log-audit.ts`](../../src/log-audit.ts) | UserPromptSubmit hook (log nudge) |
| `borg-foreign-path-reminder` | [`foreign-path-reminder.ts`](../../src/foreign-path-reminder.ts) | PreToolUse hook (path advisory) |
| `borg-inbox-monitor` | [`inbox-monitor.ts`](../../src/inbox-monitor.ts) | Claude inbox Monitor (`tail -F` wake lines) |

Borg runs an agent CLI (Claude Code, Codex or OpenCode) that the user already
installed. It does not install that CLI. The client is local-first: it talks
only to a self-hosted Borg server (`borgmcp-server`) over pinned-CA HTTPS.
Protocol envelopes, domain types and validators come from the separately
released `borgmcp-shared` dependency.

The sections below group the interface by functional area. Each entry names
its file as `file.ts:symbol`. All paths are relative to `src/`.

## Interface

### Subdirectories

- [`backends/`](./backends/EGM.md): the tmux, terminals and pastelist window
  backends for `borg launch-all` (`runTmuxBackend`, `runTerminalsBackend`,
  `runPastelistBackend`, `hasCompatibleTerminal`).

### 1. CLI entry and dispatch

Files: [`claude.ts`](../../src/claude.ts),
[`unknown-subcommand.ts`](../../src/unknown-subcommand.ts),
[`cli-platform.ts`](../../src/cli-platform.ts),
[`bare-launch-menu.ts`](../../src/bare-launch-menu.ts),
[`cli-help.ts`](../../src/cli-help.ts), [`version.ts`](../../src/version.ts),
[`debug.ts`](../../src/debug.ts).

- `claude.ts:main` (internal): the dispatch order is `runEarlyUpdate`
  (update-cmd.ts), then `initDebugFromArgv` for client-owned
  `server cube init` argv only, then `runEarlyServerFacade` (server-facade.ts),
  then `initDebugFromArgv`, `handleVersionFlag` (`--version`/`-v`) and
  `initConsolePrefix`, then `--help`/`-h`, then per-subcommand help. After
  that, `argv[2]` selects one of `setup`, `doctor`, `assimilate`, `clone`,
  `quickstart`, `reset-local-connection`, `recover-enrollment`,
  `recover-attachment`, `spawn`
  (deprecated stub), `cleanup`, `drones`, `launch`, `representative` or
  `launch-all`. Then `unknownSubcommand` rejects any other non-flag `argv[2]`
  (exit 1). Bare `borg` or flags only launch an agent.
- `claude.ts:runAssimilateEntry`, `claude.ts:createOpenCodeLaunchPlan`,
  `claude.ts:launchOpenCodeProcess`, `claude.ts:ensureResolvedCliConfigured`,
  `claude.ts:OpenCodeTargetedLaunchConfigError`.
- `unknown-subcommand.ts:KNOWN_SUBCOMMANDS`, `unknown-subcommand.ts:unknownSubcommand`.
- `cli-platform.ts:parseCliFlag` (`--cli`, `--force`,
  `--no-borg-approval-override`), `cli-platform.ts:resolveCliChoice`,
  `cli-platform.ts:detectCliAvailability`,
  `cli-platform.ts:detectCliConfiguration`,
  `cli-platform.ts:defaultCliChoiceDeps`.
- `bare-launch-menu.ts:shouldShowLaunchMenu`,
  `bare-launch-menu.ts:runBareLaunchMenu`,
  `bare-launch-menu.ts:buildLaunchMenuOptions`,
  `bare-launch-menu.ts:discoverLiveLaunchMenuCandidates`,
  `bare-launch-menu.ts:isMainGitWorktree`.
- `cli-help.ts:topLevelHelpText`, `cli-help.ts:clientSubcommandHelpText`,
  `cli-help.ts:serverHelpText`, `cli-help.ts:isHelpFlag`, and one
  `*HelpText` function for each subcommand.
- `version.ts:getPackageVersion`, `version.ts:getOnDiskVersion`,
  `version.ts:handleVersionFlag` (`--version`/`-v`).
- `debug.ts:initDebugFromArgv` (`--debug`, `BORG_DEBUG`), `debug.ts:debugLog`.

### 2. CLI commands

Files: [`assimilate-cmd.ts`](../../src/assimilate-cmd.ts),
[`assimilate-deps.ts`](../../src/assimilate-deps.ts),
[`parse-assimilate-args.ts`](../../src/parse-assimilate-args.ts),
[`repository-cube-init.ts`](../../src/repository-cube-init.ts),
[`quickstart-cmd.ts`](../../src/quickstart-cmd.ts),
[`parse-quickstart-args.ts`](../../src/parse-quickstart-args.ts),
[`clone-cmd.ts`](../../src/clone-cmd.ts),
[`parse-clone-args.ts`](../../src/parse-clone-args.ts),
[`clone-security.ts`](../../src/clone-security.ts),
[`cleanup-cmd.ts`](../../src/cleanup-cmd.ts),
[`seat-commands.ts`](../../src/seat-commands.ts),
[`reset-local-seat-cmd.ts`](../../src/reset-local-seat-cmd.ts),
[`recover-enrollment-cmd.ts`](../../src/recover-enrollment-cmd.ts),
[`recover-attachment-cmd.ts`](../../src/recover-attachment-cmd.ts),
[`server-facade.ts`](../../src/server-facade.ts),
[`update-cmd.ts`](../../src/update-cmd.ts), [`spawn.ts`](../../src/spawn.ts).

- `borg assimilate` and `borg server cube init`:
  `assimilate-cmd.ts:runAssimilate`, `assimilate-cmd.ts:prepareConnection`
  (variant with no host and no launch, used by `representative prepare`), and
  the phase functions `resolveAssimilationAuthority`,
  `resolveAssimilationRepository`, `resolveAssimilationCubeRole`,
  `prepareAssimilationSeat`, `prepareAssimilationWorktree`,
  `finalizeAssimilationSeat` and `launchAssimilatedAgent`. Also
  `assimilate-cmd.ts:AssimilateDeps` and `assimilate-cmd.ts:AssimilateFlags`.
  `assimilate-deps.ts:buildDefaultAssimilateDeps` supplies the real IO. Flags
  are parsed by `parse-assimilate-args.ts:parseAssimilateArgs`.
- Cube selection for a repository: `repository-cube-init.ts:initializeRepositoryCube`,
  `repository-cube-init.ts:validRepositoryCubeName`.
- `borg quickstart`: `quickstart-cmd.ts:runQuickstart`,
  `parse-quickstart-args.ts:parseQuickstartArgs`.
- `borg clone`: `clone-cmd.ts:runClone`, `clone-cmd.ts:validateCloneRepositoryUrl`,
  `parse-clone-args.ts:parseCloneArgs`, `clone-security.ts:redactCloneSecrets`,
  `clone-security.ts:hasCloneCredentials`.
- `borg cleanup [--prune]`: `cleanup-cmd.ts:runCleanup`,
  `cleanup-cmd.ts:buildCleanupReport`, `cleanup-cmd.ts:parseCleanupArgs`,
  `cleanup-cmd.ts:CleanupReason`.
- `borg drones` and `borg launch <label|id-prefix>`:
  `seat-commands.ts:runSeats`, `seat-commands.ts:runLaunchSeat`,
  `seat-commands.ts:parseSeatsArgs`, `seat-commands.ts:parseLaunchSeatArgs`.
- `borg reset-local-connection`: `reset-local-seat-cmd.ts:runResetLocalSeat`,
  `reset-local-seat-cmd.ts:parseResetLocalSeatArgs`.
- `borg recover-enrollment`: `recover-enrollment-cmd.ts:runRecoverEnrollment`,
  `recover-enrollment-cmd.ts:parseRecoverEnrollmentArgs`.
- `borg recover-attachment --host <origin> --attempt <id> [--retire] [--yes]`:
  `recover-attachment-cmd.ts:runRecoverAttachment`,
  `recover-attachment-cmd.ts:parseRecoverAttachmentArgs`,
  `recover-attachment-cmd.ts:buildDefaultRecoverAttachmentDeps`. It reconciles
  a failed seat attachment with the server.
- `borg server ...`: `server-facade.ts:runEarlyServerFacade`,
  `server-facade.ts:parseServerFacadeArgs`,
  `server-facade.ts:SERVER_LIFECYCLE_COMMANDS`,
  `server-facade.ts:runServerFacadeProcess`.
- `borg update` / `borg upgrade`: `update-cmd.ts:runEarlyUpdate`,
  `update-cmd.ts:runUpdate`, `update-cmd.ts:parseUpdateArgs`,
  `update-cmd.ts:resolveCompatibleServerTarget`,
  `update-cmd.ts:inspectNpmPackageAt`.
- `borg spawn` (removed): `spawn.ts:runSpawn` always returns 2.

### 3. MCP server and tools

Files: [`index.ts`](../../src/index.ts),
[`tool-manifest.ts`](../../src/tool-manifest.ts),
[`tool-names.ts`](../../src/tool-names.ts),
[`tool-scope.ts`](../../src/tool-scope.ts),
[`tool-name-migration.ts`](../../src/tool-name-migration.ts),
[`startup-services.ts`](../../src/startup-services.ts),
[`assimilate-guard.ts`](../../src/assimilate-guard.ts),
[`drone-management.ts`](../../src/drone-management.ts),
[`evict-drone.ts`](../../src/evict-drone.ts),
[`local-manage-tool-result.ts`](../../src/local-manage-tool-result.ts),
[`direct-log.ts`](../../src/direct-log.ts),
[`log-provenance.ts`](../../src/log-provenance.ts),
[`lifecycle-log-guard.ts`](../../src/lifecycle-log-guard.ts),
[`read-log-digest.ts`](../../src/read-log-digest.ts),
[`readiness-probe.ts`](../../src/readiness-probe.ts).

- `index.ts:main`: the stdio MCP server, named `borg-mcp-client`. Its
  `CallTool` switch handles the 41 tools in `tool-names.ts:MAIN_TOOL_NAMES`
  and `tool-manifest.ts:TOOL_MANIFEST`. These are `borg_regen`,
  `borg_assimilate`, `borg_cube`, `borg_role`, `borg_version`, `borg_playbook`,
  `borg_docs`, `borg_whoami`, `borg_role_rationale`, `borg_roster`,
  `borg_stream_status`, `borg_read_log`, `borg_read_entry`, `borg_ack`,
  `borg_ack_status`, `borg_decide`, `borg_decisions`, `borg_remove_decision`,
  `borg_put_document`, `borg_get_document`, `borg_list_documents`,
  `borg_remove_document`, `borg_log`, `borg_list_cubes`, `borg_create_cube`,
  `borg_update_cube`, `borg_patch_taxonomy_class`, `borg_delete_cube`,
  `borg_create_role`, `borg_update_role`, `borg_patch_role_section`,
  `borg_delete_role`, `borg_reassign_drone`, `borg_evict_drone`,
  `borg_list_drones`, `borg_list_roles`, `borg_list_templates`,
  `borg_apply_template`, `borg_sync_roles`, `borg_tool` (dispatcher) and
  `borg_describe_tool`. The server exposes no prompts.
- Other `index.ts` exports: `runApplyTemplateTool`, `appendServerAdvisory`,
  `formatUpdatedCubeResult`, `formatUpdatedRoleResult`,
  `formatPatchedRoleSectionResult`, `resolveAckKind`,
  `buildReadLogStructuredContent`, `connectOpenCodeRuntime`.
- `tool-manifest.ts:TOOL_OUTPUT_SCHEMAS`, `tool-manifest.ts:ToolManifestEntry`.
- `tool-names.ts:canonicalToolName`, `tool-names.ts:LEGACY_TOOL_ALIASES`
  (32 frozen hyphenated aliases), `tool-names.ts:toolNameSpellings`,
  `tool-names.ts:REPRESENTATIVE_CANONICAL_TOOL_NAMES`.
- `tool-scope.ts:filterToolsForRole`, `tool-scope.ts:deferredToolNames`,
  `tool-scope.ts:UNIVERSAL_TOOLS`, `tool-scope.ts:MANAGEMENT_TOOLS`.
- `tool-name-migration.ts:assertToolNamePoliciesMigrated`,
  `tool-name-migration.ts:assertClaudeHookPoliciesMigrated`,
  `tool-name-migration.ts:ToolNameMigrationError`.
- `startup-services.ts:runMcpStartupServices`.
- `assimilate-guard.ts:classifyInSessionAssimilate`,
  `assimilate-guard.ts:reattachOnlyRefusal`.
- `drone-management.ts:runReassignDroneTool`,
  `drone-management.ts:runEvictDroneTool`; `evict-drone.ts:isUuidShape`,
  `evict-drone.ts:assertUuidShape`, `evict-drone.ts:resolveDroneIdByLabel`.
- `local-manage-tool-result.ts:formatLocalManageToolResult`,
  `local-manage-tool-result.ts:RoleSectionConflictError`.
- `direct-log.ts:normalizeLogAudience` (the `borg_log` `to` field).
- `log-provenance.ts:validateRefs`, `log-provenance.ts:resolveRefs`,
  `log-provenance.ts:auditMessageShas`, `log-provenance.ts:requiresRefs`.
- `lifecycle-log-guard.ts:shouldSuppressLifecycleLog`,
  `lifecycle-log-guard.ts:recordLifecycleLog`.
- `read-log-digest.ts:buildReadLogDigest`, with `DIGEST_THRESHOLD`=50,
  `DIGEST_TAIL`=25 and `DIGEST_FETCH_CAP`=2000.
- `readiness-probe.ts:MCP_READINESS_PROBE_ENV` (`BORG_MCP_READINESS_PROBE`).

### 4. Server connection, trust and HTTP client

Files: [`remote-client.ts`](../../src/remote-client.ts),
[`server-handshake.ts`](../../src/server-handshake.ts),
[`server-trust.ts`](../../src/server-trust.ts),
[`server-errors.ts`](../../src/server-errors.ts),
[`server-response.ts`](../../src/server-response.ts),
[`server-endpoint.ts`](../../src/server-endpoint.ts),
[`invitation-artifact.ts`](../../src/invitation-artifact.ts),
[`enrollment-lock.ts`](../../src/enrollment-lock.ts),
[`enrollment-types.ts`](../../src/enrollment-types.ts),
[`drone-lifecycle.ts`](../../src/drone-lifecycle.ts),
[`seat-probe.ts`](../../src/seat-probe.ts),
[`first-run-server.ts`](../../src/first-run-server.ts).

- Seat-scoped calls: `remote-client.ts:regen`, `whoami`, `getCubeInfo`,
  `getRoleInfo`, `getRoleInfoByName`, `roleRationale`, `getRoster`, `readLog`,
  `readLogEntry`, `appendLog`, `ackLogEntry`, `getAckStatus`,
  `recordDecision`, `listDecisions`, `removeDecision`, `putDocument`,
  `getDocument`, `listDocuments`, `removeDocument`, `hasPendingWakeActivity`
  and `hasPendingWakeEntry`.
- Management calls, which need the owner credential: `remote-client.ts:listCubes`,
  `createCube`, `updateCube`, `patchTaxonomyClass`, `deleteCube`, `createRole`,
  `updateRole`, `patchRoleSection`, `deleteRole`, `reassignDrone`,
  `evictDrone`, `listRoles`, `getCube`, `getCubeForManagement`,
  `applyTemplate`, `syncRoles`, `resolveLocalManageAuthority` and
  `normalizeExplicitRepository`.
- `remote-client.ts:sanitizeServerAdvisory`, `remote-client.ts:retryOn429`,
  `remote-client.ts:LOCAL_SERVER_RESPONSE_LIMIT_BYTES` (32 MiB),
  `remote-client.ts:LOCAL_SERVER_REQUEST_TIMEOUT_MS` (5000).
- Handshake and enrollment: `server-handshake.ts:DEFAULT_LOCAL_SERVER_ORIGIN`
  (`https://127.0.0.1:7091`), `probeBorgServer`, `preflightBorgServerTag`,
  `enrollBorgServer`, `enrollLocalBorgServerArtifact`,
  `resumeBorgServerEnrollment`, `sendBorgServerAttach`,
  `connectEnrolledBorgServer`, `resolveBorgServerAuthority`,
  `createBorgServerCube`, `resolveBorgServerRepositoryCube` and
  `associateBorgServerRepositoryCube` (each also has a `*Local*` wrapper).
  Attachment reconciliation: `reconcileBorgServerAttachment`,
  `acknowledgeBorgServerAttachment`, `AttachmentReconciliationError`.
- Pinned trust: `server-trust.ts:createPinnedServerFetch`,
  `loadBorgServerTrust`, `readBorgServerTrustIdentity`,
  `loadBorgServerTrustFromPresentedChain`, `stageBorgServerTrust`,
  `loadStagedBorgServerTrust`, `restoreBorgServerEnrollment`,
  `clearStagedBorgServerTrust`, `clearBorgServerTrust`.
- Typed errors: `server-errors.ts:BorgServerError` (codes `NOT_ENROLLED`,
  `CREDENTIAL_REJECTED`, `INVITATION_REJECTED`, `LOCAL_CREDENTIAL_EXISTS`,
  `CREATE_CUBE_DENIED`, `ATTACH_CONFLICT`, `SESSION_REJECTED`,
  `SESSION_REVOKED`), `BorgServerHttpError`, `BorgServerTrustError`,
  `BorgServerUnreachableError`, `BorgProtocolMismatchError`,
  `LocalManageRequiredError`, `LocalManageCredentialUnavailableError`,
  `LocalUnsupportedError`, the OpenCode error classes, and the cube-creation,
  cube-deletion and repository-association error classes.
  `drone-lifecycle.ts:DroneEvictedError` and `drone-lifecycle.ts:CubeDeletedError`
  (`DRONE_EVICTED`, `CUBE_DELETED`).
- `server-response.ts:readBoundedResponseBody`,
  `server-endpoint.ts:normalizeServerEndpoint` (HTTPS origin only).
- `invitation-artifact.ts:decodeAndVerifyInvitationArtifact` and the
  `InvitationArtifact*Error` classes.
- `enrollment-lock.ts:withEnrollmentOriginLock`; `enrollment-types.ts` (types only).
- `seat-probe.ts:defaultProbeSeat`, `seat-probe.ts:SeatStatus`.
- `first-run-server.ts:offerFirstRunServerInstall`.

### 5. Seats, identity and local state

Files: [`cubes.ts`](../../src/cubes.ts), [`seats.ts`](../../src/seats.ts),
[`seat-store.ts`](../../src/seat-store.ts),
[`config.ts`](../../src/config.ts),
[`credential-paths.ts`](../../src/credential-paths.ts),
[`token-store.ts`](../../src/token-store.ts),
[`private-root.ts`](../../src/private-root.ts),
[`guarded-fs.ts`](../../src/guarded-fs.ts),
[`repository-identity.ts`](../../src/repository-identity.ts),
[`working-repo.ts`](../../src/working-repo.ts),
[`local-server-cursor.ts`](../../src/local-server-cursor.ts),
[`display-identity.ts`](../../src/display-identity.ts),
[`console-prefix.ts`](../../src/console-prefix.ts),
[`role-resolver.ts`](../../src/role-resolver.ts),
[`role-match.ts`](../../src/role-match.ts),
[`runtime-metadata.ts`](../../src/runtime-metadata.ts),
[`agent-session-identity.ts`](../../src/agent-session-identity.ts),
[`seat-reattach-guard.ts`](../../src/seat-reattach-guard.ts),
[`worktree-lifecycle.ts`](../../src/worktree-lifecycle.ts),
[`cube-name.ts`](../../src/cube-name.ts),
[`name-validator.ts`](../../src/name-validator.ts),
[`self-path.ts`](../../src/self-path.ts).

- `cubes.ts:getActiveCube`, `getActiveCubeForWorktree`, `findProjectRoot`,
  `inboxPathForDrone`, `atomicWriteFile`, `pinMcpSeatIdentity`,
  `pinMcpProjectRoot`, `withLaunchSeatExpectationEnv`
  (`BORG_LAUNCH_EXPECTED_SEAT`), `snapshotLocalSeat`, `resetLocalSeatBinding`,
  `refreshActiveCubeMetadata`, `readAllProjectIdentities`,
  `getProjectCliPreference`, `setProjectCliPreference`,
  `LaunchSeatIdentityChangedError` and `McpSeatIdentityChangedError`. Also the
  types `ActiveCube` and `BorgCli`.
- `seats.ts:SEATS_FILE` (`seats.json`), `seatRef`, `mintPendingSeat`,
  `prepareSeat`, `activateAndBindSeat`, `bindPendingSeatToWorktree`,
  `getActiveSeatForWorktree`, `getActiveSeatCredential`, `observeSeat`,
  `resetSeatForWorktree`, `scrubPendingSeat`, `clearSeat`,
  `refreshSeatMetadata`, `readAllActiveSeats`, `readAllBoundSeats`,
  `findIncompleteSiblingAttempt` and `AmbiguousSeatBindingError`.
  Attachment recovery: `AttachmentAttempt`, `isAttachmentAttempt`,
  `readAttachmentAttempt`, `reserveAttachmentTarget`,
  `recoverAttachmentAttempt`, `AttachmentRecoveryRequiredError`,
  `AttachmentAttemptUnavailableError`, `ActivateSeatOutcome`.
- `seat-store.ts:withStore`, `withStoreLock`, `atomicWrite0600`,
  `readStoreFile`, `assertSecureRoot`.
- `config.ts:storeServerCredential`, `getServerCredential`,
  `getOrCreatePendingServerEnrollment`, `activatePendingServerEnrollment`,
  `finalizeAcceptedEnrollment`, `findEnrollmentRecoveryTransaction`,
  `getOrCreatePendingServerCubeCreation` and `clearServerCredential`.
  `credential-paths.ts:SERVER_CREDENTIALS_FILE` (`~/.borg/credentials`).
  `token-store.ts:makeFileBackend`.
- `private-root.ts:borgHomeRoot` (`BORG_STATE_ROOT`), `borgConfigRoot`
  (`~/.config/borgmcp`), `ensurePrivateBorgConfigRoot`, `borgAgentConfigEnv`
  and `isCanonicalPath`.
- `guarded-fs.ts:fs`, `guarded-fs.ts:fsp`, `guarded-fs.ts:openSqlite`,
  `guarded-fs.ts:assertTestWritable`. This is the only module allowed to import
  fs mutation functions.
- `repository-identity.ts:resolveGitRepositoryContext`,
  `getOrCreateRepositoryIdentity`, `getRepositoryAssociation`,
  `saveRepositoryAssociation`. `working-repo.ts:resolveWorkingRepo`.
- `local-server-cursor.ts:getLocalServerCursor`,
  `advanceLocalServerCursor`, `clearLocalServerCursor`. Cursor purposes are
  the unread watermark and `'stream'`.
- `display-identity.ts:confirmDisplayIdentity`,
  `markDisplayIdentityReadFailed`; `console-prefix.ts:initConsolePrefix`,
  `console-prefix.ts:cerr`.
- `role-resolver.ts:pickDefaultRole`, `matchRoleByName`, `roleSlug`;
  `role-match.ts:assertRoleMatches`;
  `runtime-metadata.ts:buildRuntimeMetadataReport`, `buildRuntimeMetadataPatch`.
- `agent-session-identity.ts:recordClaudeSessionStart`,
  `resolveAgentSessionIdentity`.
- `seat-reattach-guard.ts:inspectLiveInboxMonitor`,
  `formatSeatReattachRefusal`.
- `worktree-lifecycle.ts:computeWorktreePath` (`~/.borg/worktrees/<repo>/<suffix>`),
  `perWorktreeBranchName` (`wt-*`), `classifyDirty`, `isMerged`,
  `cleanupMerged`.
- `cube-name.ts:deriveCubeName`, `normalizeCubeName`;
  `name-validator.ts:validateName`; `self-path.ts:resolveSelfBinPath` and its
  per-bin helpers.

### 6. Inbox, log stream and wake path

Files: [`log-stream.ts`](../../src/log-stream.ts),
[`stream-owner.ts`](../../src/stream-owner.ts),
[`stream-status.ts`](../../src/stream-status.ts),
[`inbox-monitor.ts`](../../src/inbox-monitor.ts),
[`gc-orphan-inboxes.ts`](../../src/gc-orphan-inboxes.ts),
[`wake-path-health.ts`](../../src/wake-path-health.ts),
[`codex-app-wake.ts`](../../src/codex-app-wake.ts),
[`codex-wake-resolve.ts`](../../src/codex-wake-resolve.ts),
[`codex-app-server.ts`](../../src/codex-app-server.ts),
[`clear-rewake.ts`](../../src/clear-rewake.ts),
[`clear-rewake-core.ts`](../../src/clear-rewake-core.ts),
[`claude-wake-copy.ts`](../../src/claude-wake-copy.ts),
[`cube-activity-wake-copy.ts`](../../src/cube-activity-wake-copy.ts),
[`opencode-wake-copy.ts`](../../src/opencode-wake-copy.ts).

- `log-stream.ts:startLogStream`, `streamOnce`, `streamOnceIfOwner`,
  `parseSSE`, `getStreamStatus`, `classifyRunLoopHealth`,
  `streamReconnectDelay`, `formatInboxLine`, `formatEvictionSentinelLine`,
  `appendCappedInboxLine`, `trimInboxFileToRecentLines`,
  `setModuleInjectOpenCode`, `StreamCursorExpiredError`,
  `INBOX_TAIL_LINES_CAP` (512) and `LOCAL_SERVER_SSE_FRAME_LIMIT_BYTES` (64 KiB).
- `stream-owner.ts:acquireStreamLease`, `readOwnershipSnapshot`,
  `streamLockPath`, `STREAM_OWNER_STALE_MS` (70 s).
- `stream-status.ts:renderStreamStatus`, `checkInboxMonitorHealthy`,
  `formatWakePathPrefix`, `shouldShowWakePathWarning`.
- `inbox-monitor.ts` bin (`borg-inbox-monitor --state-root <root> <inbox>`,
  or the legacy form `borg-inbox-monitor <inbox>` with no state root, which
  `claude-wake-copy.ts:claudeMonitorCommand` still emits when it gets no state
  root; `parseMonitorInvocation`),
  plus `acquireInboxLock`, `planArmReplay`, `evaluateInboxTailStall`,
  `monitorStateRootForWorktree`, `pidfilePathFor`, `heartbeatPathFor` and
  `HEARTBEAT_STALE_MS` (150 s).
- `gc-orphan-inboxes.ts:gcOrphanInboxesForCube`, `selectOrphanInboxes`,
  `isInboxLive`, `ORPHAN_INBOX_STALE_MS` (30 days).
- `wake-path-health.ts:inspectWakePath`.
- `codex-app-wake.ts:wakeCodexViaAppServer`, `startCodexHeartbeat`,
  `fireCodexHeartbeatTick`, `codexWakePathHealthy`, `probeCodexBridgeArmed`
  and `CODEX_HEARTBEAT_CADENCE_MS` (20 min).
  `codex-wake-resolve.ts:pickFreshThread`, `wakeRetryBackoffMs`,
  `BORG_CODEX_APP_SERVER_SOCKET_ENV`.
  `codex-app-server.ts:CodexAppServerClient` (JSON-RPC over a unix-socket
  WebSocket).
- `clear-rewake-core.ts:evaluateClearRewake`, `CLEAR_REWAKE_REMINDER`.
- Wake copy: `claude-wake-copy.ts:claudeMonitorCommand`,
  `cube-activity-wake-copy.ts:CUBE_ACTIVITY_RESUME_WAKE_MESSAGE`,
  `opencode-wake-copy.ts:OPENCODE_WAKE_PATH_GUIDANCE`.

### 7. Agent launch integrations

Files (Claude): [`claude-launch-args.ts`](../../src/claude-launch-args.ts),
[`claude-effective-settings.ts`](../../src/claude-effective-settings.ts),
[`claude-policy-sources.ts`](../../src/claude-policy-sources.ts),
[`claude-managed-policy.ts`](../../src/claude-managed-policy.ts),
[`model-presets.ts`](../../src/model-presets.ts).
Files (Codex): [`codex-launch.ts`](../../src/codex-launch.ts),
[`codex-remote.ts`](../../src/codex-remote.ts).
Files (OpenCode): [`opencode-drone.ts`](../../src/opencode-drone.ts),
[`opencode-adapter.ts`](../../src/opencode-adapter.ts),
[`opencode-installation.ts`](../../src/opencode-installation.ts),
[`opencode-plugin.ts`](../../src/opencode-plugin.ts),
[`opencode-launch-plugin.ts`](../../src/opencode-launch-plugin.ts),
[`opencode-launch-trust.ts`](../../src/opencode-launch-trust.ts),
[`opencode-private-state.ts`](../../src/opencode-private-state.ts),
[`opencode-seat-identity.ts`](../../src/opencode-seat-identity.ts),
[`opencode-common-config.ts`](../../src/opencode-common-config.ts),
[`opencode-v2-launch.ts`](../../src/opencode-v2-launch.ts),
[`opencode-v2-broker.ts`](../../src/opencode-v2-broker.ts),
[`opencode-v2-server.ts`](../../src/opencode-v2-server.ts),
[`opencode-v2-runtime.ts`](../../src/opencode-v2-runtime.ts),
[`opencode-v2-permissions.ts`](../../src/opencode-v2-permissions.ts),
[`opencode-v2-startup.ts`](../../src/opencode-v2-startup.ts),
[`opencode-v2-startup-host.ts`](../../src/opencode-v2-startup-host.ts),
[`opencode-v2-transport.ts`](../../src/opencode-v2-transport.ts).
Files (shared): [`agent-runtime.ts`](../../src/agent-runtime.ts),
[`cli-tool-approval.ts`](../../src/cli-tool-approval.ts),
[`launch-gate.ts`](../../src/launch-gate.ts),
[`launch-access.ts`](../../src/launch-access.ts),
[`auth-env.ts`](../../src/auth-env.ts),
[`child-completion.ts`](../../src/child-completion.ts),
[`terminal-title.ts`](../../src/terminal-title.ts),
[`shell-escape.ts`](../../src/shell-escape.ts).

- Claude: `claude-launch-args.ts:buildClaudeLaunchArgs` (auto-allows only
  `mcp__borg__*`), `claude-effective-settings.ts:readClaudeEffectiveSettings`,
  `claude-policy-sources.ts:inspectClaudePolicySources`,
  `claude-managed-policy.ts:claudeManagedAgentDirectory`,
  `model-presets.ts:resolveLaunchEnv` (`ANTHROPIC_MODEL`).
- Codex: `codex-launch.ts:buildCodexLaunchArgs`,
  `codex-launch.ts:buildAgentKickoffPrompt`,
  `codex-remote.ts:prepareCodexRemoteLaunch` (owned
  `codex app-server --listen unix://<sock>`),
  `codex-remote.ts:checkCodexBridgeHealthy`, `codex-remote.ts:withCodexCwdArg`.
- OpenCode v1: `opencode-drone.ts:connectOpenCodeDrone`, `injectInitialKickoff`,
  `injectOpenCodeEntry`, `settleOpenCodeEntry`, `getOpenCodeConnectionState`,
  `allocateOpenCodePort`, `openCodeLaunchBinding`;
  `opencode-plugin.ts:buildBorgPluginSource`, `installBorgPlugin`,
  `createOpenCodePluginCore`.
- OpenCode common: `opencode-adapter.ts:selectOpenCodeAdapter`,
  `opencode-installation.ts:inspectOpenCodeInstallation` (major 1 or 2),
  `opencode-launch-plugin.ts:installLaunchOpenCodePlugin`,
  `migrateLegacyOpenCodePlugin`, `buildBorgV2PluginSource`;
  `opencode-launch-trust.ts:createOpenCodeLaunchTrust`;
  `opencode-seat-identity.ts:resolveOpenCodeSeatIdentity`;
  `opencode-common-config.ts:registerCommonOpenCodeMcp`;
  `opencode-private-state.ts:openCodePrivateRoot`.
- OpenCode v2: `opencode-v2-launch.ts:launchOpenCodeV2Process`,
  `opencode-v2-broker.ts:startOpenCodeV2Broker` (loopback broker with the ops
  `/bind`, `/ready`, `/unready`, `/mcp-options`, `/catalog`, `/human`,
  `/audit`, `/audit-begin`, `/logged`, `/context`, `/settle`, `/wake` and
  `/status`), `opencode-v2-broker.ts:callOpenCodeV2Broker`,
  `opencode-v2-server.ts:startOpenCodeV2Server`,
  `opencode-v2-runtime.ts:connectOpenCodeV2Runtime`, `injectOpenCodeV2Entry`,
  `opencode-v2-permissions.ts:applyOpenCodeV2LaunchPermissions`,
  `opencode-v2-startup.ts:withOpenCodeV2Startup`,
  `opencode-v2-startup-host.ts:withOpenCodeV2StartupHost`,
  `opencode-v2-transport.ts:createOpenCodeV2Transport`.
- Shared: `agent-runtime.ts:withAgentRuntimeEnv`,
  `agent-runtime.ts:resolveSessionAgentKind` (`BORG_AGENT_KIND`);
  `cli-tool-approval.ts:resolveLaunchBorgApprovals`,
  `cli-tool-approval.ts:BORG_COORDINATION_TOOLS`,
  `cli-tool-approval.ts:setupApprovalWarnings`;
  `launch-gate.ts:isBorgSession`, `launch-gate.ts:gateAllowsActivation`
  (`BORG_SESSION`); `launch-access.ts:scratchRootForSeat`,
  `launch-access.ts:codexLaunchDirectoryArgs` (`BORG_LAUNCH_WORKTREE`,
  `BORG_LAUNCH_SCRATCH`, `BORG_LAUNCH_CLI`); `auth-env.ts:envToggleOn`;
  `child-completion.ts:captureChildCompletion`;
  `terminal-title.ts:setTerminalTitle`; `shell-escape.ts:shellEscape`.

### 8. Launch-all

Files: [`launch-all-cmd.ts`](../../src/launch-all-cmd.ts),
[`launch-all-command.ts`](../../src/launch-all-command.ts),
[`launch-all-deps.ts`](../../src/launch-all-deps.ts),
[`launch-all-discovery.ts`](../../src/launch-all-discovery.ts),
[`launch-all-locks.ts`](../../src/launch-all-locks.ts),
[`parse-launch-all-args.ts`](../../src/parse-launch-all-args.ts), and
[`backends/`](./backends/EGM.md).

- `launch-all-cmd.ts:runLaunchAll`, `launch-all-cmd.ts:resolveLaunchDelayMs`
  (`--launch-delay`, `BORG_LAUNCH_DELAY_MS`, default 2000),
  `launch-all-cmd.ts:LAUNCH_ALL_NO_DISPATCH_EXIT_CODE` (2).
- `launch-all-command.ts:buildLaunchCommand`, `resolveBorgPath`;
  `launch-all-deps.ts:buildDefaultLaunchAllDeps`, `LaunchAllDeps`;
  `launch-all-discovery.ts:discoverDroneCandidates`, `DroneCandidate`;
  `launch-all-locks.ts:writeLockMarker`, `sweepStaleLocks`, `isLockLive`
  (5 min window); `parse-launch-all-args.ts:parseLaunchAllArgs` (`--mode
  tmux|terminals|pastelist`, `--only`, `--dry-run`, `--no-attach`, `--yes`,
  `--force`, `--cli`).

### 9. Human representative (Hermes)

Files: [`representative-cmd.ts`](../../src/representative-cmd.ts),
[`representative-core.ts`](../../src/representative-core.ts),
[`representative-db.ts`](../../src/representative-db.ts),
[`representative-store.ts`](../../src/representative-store.ts),
[`representative-delivery-store.ts`](../../src/representative-delivery-store.ts),
[`representative-legacy.ts`](../../src/representative-legacy.ts),
[`representative-listener.ts`](../../src/representative-listener.ts),
[`representative-push.ts`](../../src/representative-push.ts),
[`representative-mcp.ts`](../../src/representative-mcp.ts),
[`hermes-plugin-install.ts`](../../src/hermes-plugin-install.ts).

- `borg representative prepare|status|mcp|listen|reset-state|hermes-plugin`:
  `representative-cmd.ts:parseRepresentativeArgs`,
  `runRepresentativePrepare`, `runRepresentativeStatus`,
  `runRepresentativeMcp`, `runRepresentativeListen`,
  `runRepresentativeResetState`, `resolveRepresentativeContext`,
  `DEFAULT_REPRESENTATIVE_ROLE` (`hermes-representative`).
- `representative-core.ts:sendRepresentativeMessage`,
  `readRepresentativeReplies`, `deliverRepresentativeReplies`,
  `ackRepresentativeReply`, `representativeStatus`, `createSeatBackend`,
  `resolveCoordinator`, `verifyLiveBinding`, `RepresentativeError`,
  `REPRESENTATIVE_MESSAGE_LIMIT_BYTES` (3000).
- `representative-mcp.ts:serveRepresentativeMcp`: a restricted MCP server,
  `borg-human-representative`, with five tools:
  `borg_representative_status`, `borg_representative_send`,
  `borg_representative_read`, `borg_representative_deliver` and
  `borg_representative_ack`.
- `representative-listener.ts:runListener` (`listen --protocol 2`; JSON
  events `listening`, `wake`, `refused` and `stopped` on stdout; acks on stdin),
  `representative-listener.ts:representativeListenerStatus`;
  `representative-push.ts:PushEngine`, `parseAck`, `readWakeSummary`.
- State database: `representative-db.ts:createRepresentativeState`,
  `resetRepresentativeState`, `publishGeneration`, `representativeStateRoot`
  (`<config>/representative/state`). SQL tables: `meta`, `bindings`,
  `delivery`, `returned`, `requests`, `wake_state` and `wake_replies`. Schema
  `borg-representative/1`.
- `representative-store.ts:createRepresentativeStore`, `bindingFingerprint`,
  `RepresentativeGenerationError`;
  `representative-delivery-store.ts:ensureDeliveryState`, `advanceCheckpoint`,
  `widenReadWindow`; `representative-legacy.ts:legacySeed`,
  `previewLegacyImport`.
- Hermes plugin: `hermes-plugin-install.ts:runHermesPluginInstall`,
  `runHermesPluginUninstall`, `activateHermesPlugin` (called by `borg update`),
  `hermesPluginStatus`, `HERMES_PLUGIN_NAME` (`borg-representative-push`) and
  `HERMES_MCP_SERVER_NAME` (`borg-representative`).

### 10. Setup, agent config and health

Files: [`setup.ts`](../../src/setup.ts),
[`setup-confirm.ts`](../../src/setup-confirm.ts),
[`setup-selection.ts`](../../src/setup-selection.ts),
[`config-utils.ts`](../../src/config-utils.ts),
[`ensure-mcp-config.ts`](../../src/ensure-mcp-config.ts),
[`resolved-cli-config.ts`](../../src/resolved-cli-config.ts),
[`agent-integration-health.ts`](../../src/agent-integration-health.ts).

- `setup.ts` (bin, `borg setup [--yes]`);
  `setup-confirm.ts:confirmConfigMutation`, `configMutationTargets`;
  `setup-selection.ts:setupAgentChoices`, `resolveSetupAgentSelection`.
- `config-utils.ts:addMcpServer`, `addCodexMcpServer`, `addOpenCodeMcpServer`,
  `addSessionStartHook`, `addProjectSessionStartHook`,
  `addUserPromptSubmitHook`, `addCodexSessionStartHook`,
  `addCodexUserPromptSubmitHook`, `addClaudeLaunchAccess`,
  `addOpenCodeLaunchAccess`, `provisionLaunchAccess`,
  `refreshManagedAgentHookConfigs`, `refreshManagedAgentMcpConfigs`,
  `inspectManagedAgentHookConfigs`, the `is*Configured`/`is*Registered`
  checks, and `parseJsonc`.
- `ensure-mcp-config.ts:ensureCliMcpConfigured`;
  `resolved-cli-config.ts:configureResolvedCli`.
- `agent-integration-health.ts:runDoctor` (`borg doctor`),
  `inspectAgentIntegrationHealth`, `warnIfAgentIntegrationUnhealthy`,
  `refreshAndVerifyManagedAgentIntegrations`, `AGENT_HOOK_BINS`.

### 11. Rendering and documentation surfaces

Files: [`regen.ts`](../../src/regen.ts),
[`regen-format.ts`](../../src/regen-format.ts),
[`docs-sections.ts`](../../src/docs-sections.ts),
[`document-render.ts`](../../src/document-render.ts),
[`roster-render.ts`](../../src/roster-render.ts),
[`list-roles-render.ts`](../../src/list-roles-render.ts),
[`sync-roles-render.ts`](../../src/sync-roles-render.ts),
[`assimilate-welcome.ts`](../../src/assimilate-welcome.ts),
[`foreign-path-reminder.ts`](../../src/foreign-path-reminder.ts),
[`log-audit.ts`](../../src/log-audit.ts),
[`log-audit-core.ts`](../../src/log-audit-core.ts).

- `regen.ts` (bin `borg-regen`); `regen-format.ts:formatRegenMarkdown`,
  `formatLeanOrientation`, `fitLeanOrientation`
  (`LEAN_ORIENTATION_BUDGET_BYTES`=2048), `getDronePlaybook`,
  `getDronePlaybookChapter`, `wakePathSteps`, `compressRoleText` and
  `formatLogEntryMarkdown`.
- `docs-sections.ts:DOCS_SECTIONS`, `matchDocsSections`, `formatDocsIndex`.
  This is the index that `borg_docs` serves, and it is a separate surface from
  the README and `cli-help.ts`.
- `document-render.ts:formatDocument`, `formatDocumentCitations`;
  `roster-render.ts:renderRoster`, `RUNTIME_METADATA_ADVISORY`;
  `list-roles-render.ts:renderRoleList`;
  `sync-roles-render.ts:renderSyncRolesResult`, `escapeSyncDisplay`;
  `assimilate-welcome.ts:renderAssimilationWelcome`.
- Hook bins: `foreign-path-reminder.ts` (never denies; advisory only);
  `log-audit.ts` with `log-audit-core.ts:evaluateLogAudit` (nudge after 3 or
  more state-changing tool calls without a `borg_log`).

## Invariants

- Activation gate. `BORG_SESSION` turns Borg tools and hooks on. It is not a
  security boundary. Every MCP tool except `borg_describe_tool` refuses
  unless the session was launched by borg (`launch-gate.ts:gateAllowsActivation`,
  `index.ts`). `tool-scope.ts:filterToolsForRole` only hides tools. The server
  enforces the per-cube grants.
- `borg_assimilate` in a session only re-attaches. It never mints a drone
  (`assimilate-guard.ts:classifyInSessionAssimilate`, `index.ts`).
- The server endpoint must be an HTTPS origin. Loopback gets no plaintext
  exemption (`server-endpoint.ts:normalizeServerEndpoint`). Every server
  request uses `redirect:'error'` and the pinned-CA fetch
  (`server-trust.ts:createPinnedServerFetch`, TLS 1.3 minimum). A trust
  identity mismatch is terminal (`BorgServerTrustError`). The client
  classifies it by type, never by message text.
- `remote-client.ts` authenticated requests accept only paths that match
  `^/api/cubes(/|$)`. Response bodies are bounded (32 MiB, and 64 KiB for error
  bodies). The client retries a transport failure once, only for the
  `unread-cursor` and `append-log` modes and only on ECONNRESET.
- Seat credentials. Only `seats.ts:getActiveSeatCredential` returns a raw
  bearer. A seat is minted as `pending` before any network send, and it becomes
  `active` and bound to a worktree in one commit (`activateAndBindSeat`).
  Stores fail closed: a malformed `seats.json`, `credentials`, `launch.json`
  or cursor file is never overwritten. Store locks are never stolen
  (`seat-store.ts:withStoreLock`). All store files are mode 0600 inside
  owner-only (0700) directories.
- Filesystem mutation goes through `guarded-fs.ts`. Under the test runner it
  refuses paths in the operator's real home.
- `cubes.ts:inboxPathForDrone` and the lock and stream paths require
  UUID-shaped cube and drone ids. This prevents path traversal.
- Cursors only move forward: the unread watermark and the stream cursor
  (`local-server-cursor.ts:advanceLocalServerCursor`), the representative
  delivery checkpoint, and the push-engine frontier. In the log stream, the
  inbox line is written before the cursor advances (the local
  `writeInboxLine` closure inside `log-stream.ts:streamOnce`; it is not a
  module symbol).
- One SSE stream owner per (cube, drone). Ownership is a mkdir lease with
  heartbeat and takeover verification (`stream-owner.ts`). There is one inbox
  monitor per inbox, and it never kills a live holder
  (`inbox-monitor.ts:acquireInboxLock`).
- Codex remote control belongs to Borg. A passthrough `--remote` is refused
  (`codex-launch.ts:buildCodexLaunchArgs`). Borg tool approvals are applied
  only as launch-time overrides after verification. Borg never rewrites the
  operator's config for approvals (`cli-tool-approval.ts`). An unmigrated
  legacy tool-name policy blocks the launch
  (`tool-name-migration.ts:ToolNameMigrationError`).
- OpenCode v2 accepts only 2.1.2 or later. Borg owns the server, the session and
  the kickoff. Exactly one kickoff is sent, and only after the TUI starts
  (`opencode-v2-launch.ts`). Broker capabilities are compared in constant
  time, and descriptors are signed with Ed25519 (`opencode-v2-broker.ts`).
- `borg cleanup --prune` deletes a worktree only when a probe with that
  worktree's own seat token returns `evicted`. It uses `git worktree remove`
  without `--force` and `git branch -d` (`cleanup-cmd.ts`).
- `borg reset-local-connection` makes no network calls. It re-verifies the
  snapshot before it deletes anything (`reset-local-seat-cmd.ts`).
- `borg update` installs with `--ignore-scripts`. It refuses a client/server
  pair whose `borgmcp-shared` pins differ (`update-cmd.ts`).
- Representative. A `decision` send needs `user_authorized`. Messages go
  only to the one bound Coordinator. A binding generation change stops every
  operation (`representative-core.ts`, `representative-store.ts`,
  `representative-listener.ts`).
- Documentation surfaces are separate: README, `cli-help.ts` and
  `docs-sections.ts`. A term defined in one does not reach the others.

## Side Effects

- Local state under `borgConfigRoot()` (`~/.config/borgmcp`, or
  `$BORG_STATE_ROOT/.config/borgmcp`): `seats.json`, `launch.json`,
  `inboxes/<cube>/<drone>.log`, `local-server-cursors.json`,
  `lifecycle-log-state.json`, `repository-identities.json`,
  `repository-identity.key`, `stream-locks/`, `locks/<cube>/`,
  `repository-identities.lock`, `codex-remote/`, `representative/state/`,
  `representative-listener-locks/<authority>/`, `hermes-plugin/`,
  `opencode-drone-*.log` and, on Windows only, `opencode-launches/`. The
  legacy `representative.json` and `representative-delivery/` are read only,
  for import (`representative-legacy.ts`).
- Under `~/.borg/`: `credentials` (server credential and enrollment records),
  `server-trust/<sha256(origin)>/`, `worktrees/<repo>/<name>` (sibling git
  worktrees) and `scratch/<label>`.
- Per worktree: `<worktree>/.borgmcp/` (Claude session record, inbox-monitor
  state: pidfile, heartbeat, replay cursor), `.claude/settings.local.json`
  and `.opencode/opencode.json`.
- Agent CLI configuration: `~/.claude.json`, `~/.claude/settings.json`,
  `~/.codex/config.toml`, `~/.codex/hooks.json` and `~/.config/opencode/`.
  The writes go through `config-utils.ts` and through each CLI's own
  `mcp add` command.
- Network: HTTPS to the Borg server (`/api/cubes/...`, `/api/client/attach`,
  `/api/enrollment/exchange`, `/api/repository-cubes/...`, `/api/protocol`
  and `/healthz`), an SSE stream at `/api/cubes/{id}/stream`, the npm registry
  (`borg update`, first-run server install), and loopback HTTP to OpenCode
  servers and the v2 broker.
- Processes: the agent CLI (`claude`, `codex`, `opencode`),
  `codex app-server`, `opencode serve`, `borg-mcp-server`, `npm`, `git`,
  `tmux`, `osascript`, terminal emulators, `tail -F`, `pgrep`, the `hermes`
  CLI and `powershell.exe` (Windows ACLs).
- Env vars read: `BORG_SESSION`, `BORG_AGENT_KIND`, `BORG_STATE_ROOT`,
  `BORG_API_URL`, `BORG_DEBUG`, `BORG_LAUNCH_*`, `BORG_OPENCODE*`,
  `BORG_CODEX_*`, `BORG_SERVER_DATA_DIR`, `BORG_UPDATE_REENTRY`,
  `BORG_DISABLE_LAUNCH_REMINDER`, `BORG_MCP_READINESS_PROBE`,
  `BORG_CLAUDE_LAUNCH_CORRELATION`, `BORG_TERMINAL`/`TERMINAL`, `TMUX`,
  `DISPLAY`/`WAYLAND_DISPLAY`, `HOME`/`USERPROFILE`, `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`,
  `OPENCODE_CONFIG_CONTENT`, `HERMES_HOME`, `NO_COLOR`, `CI`, and the
  test-isolation vars `BORGMCP_TEST_FORBIDDEN_HOME` and
  `BORGMCP_TEST_ALLOWED_ROOTS` (`guarded-fs.ts`).
- Env vars written for agent children: when `BORG_STATE_ROOT` is set,
  `private-root.ts:borgAgentConfigEnv` sets `HOME` to the state root,
  `CODEX_HOME` to `<root>/.codex` and `XDG_CONFIG_HOME` to `<root>/.config`.
- Output: stdout carries JSON-RPC for the MCP servers and JSON lines for
  `representative listen`. Diagnostics go to stderr.

## Verification

- Run: `npm test` (Vitest unit suite `test:unit` and release-lane suite
  `test:release`).
- Run: `npm run check` (Node preflight and typecheck; no tests).
