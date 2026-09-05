import { dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { roleSlug, matchRoleByName, occupiedRoleIdsForAutoRole, pickDefaultRole, } from './role-resolver.js';
import { validateName } from './name-validator.js';
import { renderAssimilationWelcome } from './assimilate-welcome.js';
import { shellEscape } from './shell-escape.js';
import { buildAgentKickoffPrompt, buildKickoffWakePathClause, buildCodexLaunchArgs, } from './codex-launch.js';
import { perWorktreeBranchName, computeWorktreePath, localBranchExists, isMerged } from './worktree-lifecycle.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { withAgentRuntimeEnv, } from './agent-runtime.js';
import { inboxPathForDrone, } from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import { formatSeatReattachRefusal, inspectLiveInboxMonitor, } from './seat-reattach-guard.js';
import { resolveLaunchEnv } from './model-presets.js';
import { unlinkSync } from 'node:fs';
import { gcOrphanInboxesForCube, defaultListInboxLogs, defaultInboxLivenessDeps, isInboxLive, ORPHAN_INBOX_STALE_MS, } from './gc-orphan-inboxes.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { allocateOpenCodePort, connectOpenCodeDrone, createOpenCodeLaunchKickoff, injectInitialKickoff } from './opencode-drone.js';
import { BORG_OPENCODE_LAUNCH_CORRELATION_ENV, OPENCODE_SERVER_PASSWORD_ENV, OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_USERNAME_ENV, } from './opencode-launch-trust.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { DEFAULT_LOCAL_SERVER_ORIGIN } from './server-handshake.js';
import { BorgServerError, CubeCreationConfirmationError, CubeCreationOutcomeUnknownError, LegacySessionCredentialCollisionError, RepositoryAssociationOperationError, RepositoryAssociationOutcomeUnknownError, RepositoryAssociationResolutionError, } from './server-errors.js';
import { decodeAndVerifyInvitationArtifact, InvitationArtifactCompatibilityError, InvitationArtifactEndpointMismatchError, InvitationArtifactFormatError, InvitationArtifactLegacyError, InvitationArtifactRecoveryError, InvitationArtifactStorageError, InvitationArtifactTransportError, InvitationArtifactTrustError, } from './invitation-artifact.js';
import { createHash } from 'node:crypto';
import { buildOpenCodeLaunchArgs } from './cli-tool-approval.js';
import { resolveWorkingRepo } from './working-repo.js';
import { BORG_LAUNCH_CLI_ENV, BORG_LAUNCH_SCRATCH_ENV, BORG_LAUNCH_WORKTREE_ENV, codexLaunchDirectoryArgs, scratchRootForSeat, } from './launch-access.js';
import { initializeRepositoryCube, RepositoryAssociationConfirmationError, RepositoryAssociationSaveError, validRepositoryCubeName, } from './repository-cube-init.js';
import { repositoryDiscoveryFailureMessage, } from './repository-identity.js';
const PRIVATE_STATE_UNAVAILABLE_COPY = [
    'Borg could not safely prepare its private local state.',
    'No Borg server or cube change was made.',
    "Before retrying, verify that Borg-owned directories are real, owned by your account, and not writable by other users. Verify that their parent directories are real, trusted directories owned by your account or the system and not writable by other users. Verify that Borg files are private regular files owned by your account, then run the same command again.",
].join('\n');
function affirmative(answer) {
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
}
function strictAffirmative(answer) {
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
}
async function selectAssimilationAuthority(flags, deps, mode) {
    if (flags.server !== undefined) {
        try {
            return { kind: 'server', apiUrl: normalizeServerEndpoint(flags.server) };
        }
        catch (error) {
            deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
            return null;
        }
    }
    // Only a local self-hosted server authority exists. Non-TTY and --yes must
    // NOT infer an authority — fail closed with actionable guidance.
    if (flags.enroll && deps.isTTY()) {
        // The v2 enrollment artifact is itself the authority selector. Use the
        // local origin only as a placeholder until the hidden artifact is decoded.
        return { kind: 'server', apiUrl: DEFAULT_LOCAL_SERVER_ORIGIN };
    }
    if (!deps.isTTY() || flags.yes) {
        if (deps.defaultAuthority)
            return deps.defaultAuthority;
        const command = mode === 'cube-init'
            ? '`borg server cube init --host <host>`'
            : '`borg assimilate --host <host> --here`';
        deps.stderr(`No local server selected. Use ${command} to select a local server.\n`);
        return null;
    }
    let detected = null;
    try {
        const candidate = await deps.detectLocalServer();
        detected = candidate ? normalizeServerEndpoint(candidate) : null;
    }
    catch {
        // Detection is advisory. A failed probe is the same UX state as "none
        // found"; an explicitly selected endpoint remains fail-closed below.
    }
    let hostPrompt;
    if (detected) {
        const answer = await deps.prompt(`Local Borg server detected at ${detected}.\nConnect this project to it? [Y/n]: `);
        if (affirmative(answer))
            return { kind: 'server', apiUrl: detected };
        hostPrompt =
            'Enter another Borg server host or URL (e.g. 127.0.0.1:7091 or https://server.local:7091; bare hosts default to HTTPS).\n' +
                'Borg server host or URL: ';
    }
    else {
        const rerunCommand = mode === 'cube-init' ? 'borg server cube init' : 'borg assimilate';
        hostPrompt =
            `No running Borg server was found at ${DEFAULT_LOCAL_SERVER_ORIGIN} (the default).\n` +
                '- If your server runs on another host or port, enter it below (e.g. 127.0.0.1:7091 or https://server.local:7091; bare hosts default to HTTPS).\n' +
                `- If your server is installed but stopped, run \`borg server start\`, then rerun \`${rerunCommand}\`.\n` +
                '- If you do not have a server yet, cancel (Ctrl-C) and run `borg server setup`.\n' +
                'Borg server host or URL: ';
    }
    const host = await deps.prompt(hostPrompt);
    try {
        return { kind: 'server', apiUrl: normalizeServerEndpoint(host) };
    }
    catch (error) {
        deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        return null;
    }
}
function localAssimilateCommand(apiUrl, enroll = false, mode = 'assimilate') {
    const command = mode === 'cube-init' ? 'borg server cube init' : 'borg assimilate';
    const host = apiUrl === undefined ? '' : ` --host ${apiUrl}`;
    return `\`${command}${host}${enroll ? ' --enroll' : ''}\``;
}
function localAssimilateRoleCommand(apiUrl) {
    return `\`borg assimilate --host ${apiUrl} <role>\``;
}
function localAssimilateCliCommand(apiUrl, cli) {
    return `\`borg assimilate --host ${apiUrl} --cli ${cli}\``;
}
function isLoopbackHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
function isSiblingEndpoint(reachedOrigin, enrolledOrigin) {
    const reached = new URL(reachedOrigin);
    const enrolled = new URL(enrolledOrigin);
    return reached.hostname === enrolled.hostname
        || (reached.port === enrolled.port
            && isLoopbackHostname(reached.hostname)
            && isLoopbackHostname(enrolled.hostname));
}
async function reportServerFailure(deps, apiUrl, error, enroll = false, mode = 'assimilate') {
    const message = error instanceof Error ? error.message : String(error);
    const retryCommand = localAssimilateCommand(apiUrl, enroll, mode);
    if (error instanceof BorgServerError && error.code === 'CREATE_CUBE_DENIED') {
        deps.stderr(`This enrolled client cannot create a cube on ${apiUrl}. ` +
            'Ask the server operator to grant access to a cube, then rerun ' +
            `${localAssimilateCommand(apiUrl, false, mode)}.\n`);
        return 1;
    }
    if (error instanceof BorgServerError && error.code === 'NOT_ENROLLED') {
        let enrolledOrigins = [];
        try {
            enrolledOrigins = (await deps.listServerCredentialOrigins?.(apiUrl) ?? []).filter((origin) => {
                try {
                    const parsed = new URL(origin);
                    return parsed.protocol === 'https:' && parsed.origin === origin && origin !== apiUrl;
                }
                catch {
                    return false;
                }
            });
        }
        catch {
            // Preserve the existing recovery when the optional diagnostic lookup is unavailable.
        }
        const siblingOrigins = enrolledOrigins.filter((origin) => isSiblingEndpoint(apiUrl, origin));
        if (siblingOrigins.length > 0) {
            const enrollmentLabel = siblingOrigins.length === 1 ? 'a saved enrollment' : 'saved enrollments';
            const commandLabel = siblingOrigins.length === 1 ? 'the enrolled endpoint' : 'one of the enrolled endpoints';
            const commands = siblingOrigins
                .map((origin) => localAssimilateCommand(origin, false, mode))
                .join(' or ');
            deps.stderr(`Borg found ${enrollmentLabel} for ${siblingOrigins.join(', ')}, but this command is reaching ${apiUrl}. ` +
                `Use ${commandLabel} instead: ${commands}.\n`);
            return 1;
        }
        if (enrolledOrigins.length > 0) {
            deps.stderr(`This client is enrolled against ${enrolledOrigins.join(', ')}, not ${apiUrl}. ` +
                `Confirm that the host, port, and IPv4 or IPv6 loopback ` +
                `form in ${apiUrl} match the endpoint used during enrollment. If this client has never ` +
                `enrolled with that server, run ${localAssimilateCommand(apiUrl, true, mode)} from the ` +
                `operator’s terminal.\n`);
            return 1;
        }
        deps.stderr(`Borg could not find a saved enrollment for ${apiUrl}. ` +
            `This can mean that this client has not enrolled with the server, or that its enrollment ` +
            `is saved for a different endpoint. Confirm that the host, port, and IPv4 or IPv6 ` +
            `loopback form in ${apiUrl} match the endpoint used during enrollment. ` +
            `If this client has never enrolled with that server, run ` +
            `${localAssimilateCommand(apiUrl, true, mode)} from the operator’s terminal.\n`);
        return 1;
    }
    if (error instanceof BorgServerError && error.code === 'CREDENTIAL_REJECTED') {
        deps.stderr(`The saved enrollment for ${apiUrl} was rejected. Re-run ` +
            `${localAssimilateCommand(apiUrl, true, mode)} from the operator’s terminal.\n`);
        return 1;
    }
    if (error instanceof BorgServerError && error.code === 'LOCAL_CREDENTIAL_EXISTS') {
        deps.stderr(`A local enrollment for ${apiUrl} already exists and was not replaced. ` +
            `Re-run ${localAssimilateCommand(apiUrl, true, mode)} and explicitly confirm replacement ` +
            'only if the first enrolled client should be abandoned.\n');
        return 1;
    }
    if (error instanceof LegacySessionCredentialCollisionError) {
        const recovery = mode === 'cube-init'
            ? localAssimilateCommand(error.origin, true, mode)
            : `borg assimilate --host ${error.origin} --enroll`;
        deps.stderr(`Local session credential collision detected.\n` +
            `No local credentials were changed.\n` +
            `Next: run ${recovery}.\n`);
        return 1;
    }
    // A pin-matched typed 401: the server verified its own identity but rejected
    // THIS worktree's session bearer with an explicit terminal outcome.
    // Distinct from a protocol/version mismatch and from a rejected enrollment:
    // only this worktree's saved local seat is affected, and recovery is scoped to
    // this worktree — no server/trust-anchor/cube/other-worktree reset, no restart
    // or version-alignment advice (#1082).
    if (error instanceof BorgServerError && error.code === 'SESSION_REVOKED') {
        return diagnoseSessionTermination(deps, apiUrl, 'revoked', mode);
    }
    if (error instanceof BorgServerError && error.code === 'SESSION_REJECTED') {
        return diagnoseSessionTermination(deps, apiUrl, 'superseded', mode);
    }
    if (error instanceof BorgServerError && error.code === 'INVITATION_REJECTED') {
        deps.stderr(`The enrollment invitation for ${apiUrl} was rejected or expired. ` +
            'Ask the server operator for a replacement invitation — the server can stay running: ' +
            'for an unclaimed owner client run `borg-mcp-server owner-invite`; for an ordinary ' +
            'client run `borg-mcp-server client-invite`. Then rerun ' +
            `${localAssimilateCommand(apiUrl, true, mode)}.\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactCompatibilityError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactLegacyError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactFormatError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactEndpointMismatchError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactTransportError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactStorageError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactRecoveryError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (error instanceof InvitationArtifactTrustError) {
        deps.stderr(`${error.message}\n`);
        return 1;
    }
    if (/HTTP 40[13]|auth(?:entication|orization)|credential.*(?:invalid|rejected)/i.test(message)) {
        deps.stderr(`The saved enrollment for ${apiUrl} was rejected. Re-run ` +
            `${localAssimilateCommand(apiUrl, true, mode)} from the operator’s terminal.\n`);
        return 1;
    }
    if (/(?:private|seat) store lock file .* is stale/i.test(message)) {
        // RULED option (b): a lock whose recorded holder is DEAD (or whose payload is
        // corrupt) is NEVER auto-removed. Surface the fail-closed guidance verbatim —
        // it already names the exact lockfile path and the delete-only-if-no-borg
        // instruction — so the operator can clear it by hand, then retry.
        deps.stderr(`${safeStderr(message)}\nAfter confirming no borg process is running and clearing the ` +
            `stale lock, rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/(?:private|seat|credential) store is busy/i.test(message)) {
        deps.stderr(`Borg's private store is busy for ${apiUrl} because another Borg process is ` +
            `creating or resuming saved connection state. Wait for it to finish, then rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/(?:(?:local )?(?:private|seat) store|(?:secure )?credential (?:store|storage))/i.test(message)) {
        deps.stderr(`Borg could not access its private store for ${apiUrl}. ` +
            `Ensure its directory on this machine is readable and writable, then rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/Borg server trust files were not found/i.test(message)) {
        deps.stderr(`This machine has no trust material for Borg server ${apiUrl}. ` +
            'For a local server on this machine, run `borg server setup`, then run ' +
            '`borg server start`, and rerun ' +
            `${retryCommand}. A server on another machine requires a supported trust-bootstrap ` +
            'step before enrollment; an invitation alone cannot establish server identity.\n');
        return 1;
    }
    if (/trust|certificate|\bCA\b|authority state|pinned identity|cross-authority/i.test(message)) {
        deps.stderr(`Borg could not verify the expected server identity for ${apiUrl}. ` +
            'Verify that this is the expected server. If it was re-initialized, ask the server ' +
            'operator to restore the expected identity. For a local server on this machine, use ' +
            '`borg server setup` and `borg server start`, then rerun ' +
            `${retryCommand}.\n`);
        return 1;
    }
    if (/connect|fetch|network|timed? ?out|timeout|ECONN|ENOTFOUND|EHOST|unreachable|aborted|socket/i.test(message)) {
        deps.stderr(`Could not reach Borg server at ${apiUrl}. ` +
            'Start or restart it with `borg-mcp-server start`, then rerun ' +
            `${retryCommand}.\n`);
        return 1;
    }
    const safeMessage = safeStderr(message)
        .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')
        .slice(0, 240);
    deps.stderr(`Borg server at ${apiUrl} returned an unexpected response: ` +
        `${safeMessage || 'request failed'}. ` +
        `Check that the client and server versions are compatible, then rerun ${retryCommand}.\n`);
    return 1;
}
function resetLocalSeatCommand(apiUrl) {
    return `\`borg reset-local-connection --host ${apiUrl}\``;
}
// Pin-matched terminal session diagnosis. This is intentionally output-only:
// only the explicit offline reset command may clear the saved local seat.
function diagnoseSessionTermination(deps, apiUrl, outcome, mode = 'assimilate') {
    const message = outcome === 'revoked'
        ? 'Local session was revoked.'
        : 'Local session was superseded by a newer enrollment.';
    const recovery = mode === 'cube-init'
        ? localAssimilateCommand(apiUrl, true, mode)
        : `borg assimilate --host ${apiUrl} --enroll`;
    deps.stderr(`${message}\n` +
        `Next: run borg reset-local-connection, then ${recovery}.\n`);
    return 1;
}
const continueAssimilation = (value) => ({
    kind: 'continue',
    value,
});
export async function resolveAssimilationRepository(args, deps) {
    const mode = args.mode ?? 'assimilate';
    if (args.flags.worktree !== undefined) {
        const validation = validateName(args.flags.worktree);
        if (!validation.ok) {
            deps.stderr(validation.error + '\n');
            return { kind: 'stop', code: 1 };
        }
    }
    if (args.flags.cubeName !== undefined && !validRepositoryCubeName(args.flags.cubeName.trim())) {
        deps.stderr('Invalid cube name. Use 1-120 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.\n');
        return { kind: 'stop', code: 1 };
    }
    let repositoryContext;
    try {
        repositoryContext = await deps.resolveRepositoryContext(deps.cwd());
    }
    catch (error) {
        if (error instanceof Error && error.message === 'BARE_REPOSITORY') {
            const command = mode === 'cube-init' ? 'borg server cube init' : 'borg assimilate';
            deps.stderr(`${command} requires a non-bare repository worktree. Clone or check out the repository, then retry.\n`);
            return { kind: 'stop', code: 1 };
        }
        deps.stderr(`Could not inspect this Git repository: ${repositoryDiscoveryFailureMessage(error)}\n` +
            'Nothing was changed.\n');
        return { kind: 'stop', code: 1 };
    }
    if (!repositoryContext) {
        deps.stderr('No Git repository was found for this directory.\n' +
            'Nothing was changed.\n' +
            'Run this command inside a Git repository.\n');
        return { kind: 'stop', code: 1 };
    }
    return continueAssimilation({ mode, repositoryContext });
}
export async function finalizeAssimilationSeat(input, deps) {
    const { activeCube, apiUrl, repositoryContext, result, sessionExpected, rollbackWorktree } = input;
    if (result.finalize === undefined || deps.finalizeServerSeat === undefined) {
        deps.stderr('Local Borg server session metadata is incomplete; no connection was saved.\n');
        rollbackWorktree();
        return { kind: 'stop', code: 1 };
    }
    let outcome;
    try {
        outcome = await deps.finalizeServerSeat({
            active: activeCube,
            commonDir: repositoryContext.commonDir,
            ...(repositoryContext.publicRepository
                ? { repositoryOrigin: repositoryContext.publicRepository.value }
                : {}),
            expected: sessionExpected,
            activate: result.finalize.activate,
            scrubPending: result.finalize.scrubPending,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.stderr(`finalizeServerSeat failed: ${message}\n`);
        rollbackWorktree();
        return { kind: 'stop', code: 1 };
    }
    if (outcome.committed)
        return continueAssimilation(undefined);
    if (outcome.reason === 'activation-failed') {
        let bindOutcome = 'unavailable';
        if (result.finalize.bindPending) {
            try {
                bindOutcome = (await result.finalize.bindPending({
                    worktree: deps.findProjectRoot(deps.cwd()),
                    name: activeCube.name,
                    droneLabel: activeCube.droneLabel,
                    ...(activeCube.roleName !== undefined ? { roleName: activeCube.roleName } : {}),
                    ...(activeCube.roleClass !== undefined ? { roleClass: activeCube.roleClass } : {}),
                    ...(activeCube.isHumanSeat !== undefined ? { isHumanSeat: activeCube.isHumanSeat } : {}),
                }));
            }
            catch {
                bindOutcome = 'threw';
            }
        }
        if (bindOutcome === 'bound') {
            deps.stderr(`This worktree's secure session on ${apiUrl} did not finish activating, but ` +
                'its resumable connection state was PRESERVED here. This worktree was NOT removed. From ' +
                `here, re-run ${localAssimilateCommand(apiUrl)} to converge (the identical connection ` +
                `is reused — no duplicate is minted), or run ${resetLocalSeatCommand(apiUrl)} to ` +
                'clear it.\n');
            return { kind: 'stop', code: 1 };
        }
        const bindFailure = bindOutcome === 'missing'
            ? 'the exact pending connection record went missing locally before it could be bound'
            : bindOutcome === 'replaced'
                ? 'the exact pending connection record was replaced locally before it could be bound; the replacement was left untouched'
                : bindOutcome === 'threw'
                    ? 'the private store could not be read or written while preserving the pending connection'
                    : 'this client did not receive a pending-connection preservation handle';
        deps.stderr(`This worktree's secure session on ${apiUrl} did not finish activating: ` +
            `${bindFailure}. The spawned worktree will be removed. No client-only command can ` +
            'prove reuse or safely clear the possibly accepted server-side drone; ask the server ' +
            'operator to inspect that drone before retrying.\n');
        rollbackWorktree();
        return { kind: 'stop', code: 1 };
    }
    deps.stderr(`This worktree's saved connection to ${apiUrl} changed during attach ` +
        '(a concurrent reset or enroll); no drone was created and nothing was overwritten. ' +
        `Re-run ${localAssimilateCommand(apiUrl)} to attach against the current state.\n`);
    rollbackWorktree();
    return { kind: 'stop', code: 1 };
}
export async function launchAssimilatedAgent(input, deps) {
    const { flags, result, cubeDetail, assignedRole, apiUrl, cli, effectiveModel, agentCwd, seatWorktree, scratchRoot, launchAccessPaths, monitorStateRoot, spawnedWorktreePath, originalCwd, } = input;
    deps.setTerminalTitle(result.drone_label, cubeDetail.name);
    const useColor = deps.isTTY() && !process.env.NO_COLOR && !process.env.CI;
    deps.stdout(renderAssimilationWelcome(result.drone_label, assignedRole.name, cubeDetail.name, useColor, apiUrl));
    if (!await deps.probeMcpReady()) {
        deps.stderr(`warning: borg-mcp readiness probe did not complete within the timeout; ` +
            `launching ${cli} anyway — the kickoff prompt's ToolSearch fallback ` +
            `will recover if the MCP server takes longer to start.\n`);
    }
    const inboxPath = deps.getInboxPath(result.cube_id, result.drone_id);
    const monitorClause = buildKickoffWakePathClause(cli, cli === 'claude' ? inboxPath : null, cli === 'claude' ? monitorStateRoot : null);
    let launchArgs;
    let codexServerCleanup = null;
    let codexRemote = null;
    const launchApproval = deps.resolveCliApprovals
        ? await deps.resolveCliApprovals(cli, agentCwd, { skipOverride: flags.noBorgApprovalOverride })
        : { codexArgs: [] };
    if (launchApproval.warning)
        deps.stderr(`warning: ${launchApproval.warning}\n`);
    const modelEnv = resolveLaunchEnv(effectiveModel);
    const childEnv = {
        ...withAgentRuntimeEnv(process.env, cli),
        ...modelEnv.set,
        BORG_SESSION: '1',
        [BORG_LAUNCH_CLI_ENV]: cli,
        [BORG_LAUNCH_WORKTREE_ENV]: seatWorktree,
        [BORG_LAUNCH_SCRATCH_ENV]: scratchRoot,
    };
    if (cli === 'opencode' && launchApproval.openCodePermission) {
        childEnv.OPENCODE_PERMISSION = launchApproval.openCodePermission;
    }
    for (const key of modelEnv.unset)
        delete childEnv[key];
    if (cli === 'codex') {
        codexRemote = await deps.prepareCodexRemoteLaunch();
        if (!codexRemote.ready) {
            const stderr = codexRemote.stderr ? `\n${codexRemote.stderr}` : '';
            deps.stderr(`Codex launch refused: ${codexRemote.reason}${stderr}\n`);
            return 1;
        }
        Object.assign(childEnv, codexRemote.env);
        codexServerCleanup = codexRemote.server.cleanup;
    }
    const kickoff = buildAgentKickoffPrompt({
        cli,
        monitorClause,
    });
    let openCodeKickoff = null;
    let dronePort;
    launchArgs = [kickoff];
    if (cli === 'codex') {
        const plan = buildCodexLaunchArgs({
            remote: codexRemote,
            cwd: agentCwd,
            kickoff,
            approvalArgs: launchApproval.codexArgs,
            accessArgs: codexLaunchDirectoryArgs(launchAccessPaths),
        });
        if (!plan.ready) {
            codexServerCleanup?.();
            deps.stderr(`Codex launch refused: ${plan.reason}\n`);
            return 1;
        }
        launchArgs = plan.args;
    }
    else if (cli === 'opencode') {
        dronePort = await allocateOpenCodePort();
        childEnv.BORG_OPENCODE_PORT = String(dronePort);
        installBorgPlugin();
        openCodeKickoff = createOpenCodeLaunchKickoff(kickoff);
        childEnv[OPENCODE_SERVER_USERNAME_ENV] = OPENCODE_SERVER_USERNAME;
        childEnv[OPENCODE_SERVER_PASSWORD_ENV] = openCodeKickoff.apiPassword;
        childEnv[BORG_OPENCODE_LAUNCH_CORRELATION_ENV] = openCodeKickoff.correlationIdentity;
        launchArgs = buildOpenCodeLaunchArgs(agentCwd, dronePort, openCodeKickoff.prompt);
    }
    let exitPromise;
    try {
        exitPromise = deps.exec(cli, launchArgs, agentCwd, childEnv);
    }
    catch (error) {
        codexServerCleanup?.();
        throw error;
    }
    if (cli === 'opencode' && openCodeKickoff) {
        const launchKickoff = openCodeKickoff;
        connectOpenCodeDrone({
            serverUrl: `http://127.0.0.1:${dronePort}`,
            apiPassword: launchKickoff.apiPassword,
            directory: agentCwd,
            droneLabel: result.drone_label,
            cubeName: cubeDetail.name,
            launchIdentity: launchKickoff.correlationIdentity,
        }).then(() => injectInitialKickoff(launchKickoff)).catch(() => { });
    }
    let exitCode;
    try {
        exitCode = await exitPromise;
    }
    finally {
        try {
            codexServerCleanup?.();
        }
        catch {
            // Best-effort cleanup after Codex exits or fails to spawn.
        }
    }
    if (spawnedWorktreePath && originalCwd !== spawnedWorktreePath) {
        deps.stderr(`\nAgent exited. You were working in ${spawnedWorktreePath}; your shell is back in ${originalCwd}.\n` +
            'To return:\n' +
            `  cd ${shellEscape(spawnedWorktreePath)}\n`);
    }
    return exitCode;
}
export async function resolveAssimilationCubeRole(input, deps) {
    const { requestedRole, flags, cubeDetail, isFirstDrone, savedLocalRole, apiUrl } = input;
    let resolvedRole;
    if (savedLocalRole) {
        resolvedRole = savedLocalRole;
    }
    else if (requestedRole !== undefined) {
        resolvedRole = matchRoleByName(cubeDetail.roles, requestedRole);
        if (!resolvedRole) {
            const available = cubeDetail.roles.map((role) => role.name).join(', ');
            const suggestion = suggestRoleName(requestedRole, cubeDetail.roles.map((role) => role.name));
            const suggestionLine = suggestion ? ` Did you mean "${suggestion}"?` : '';
            deps.stderr(`No role matching "${requestedRole}" in cube "${cubeDetail.name}" on ${apiUrl}. ` +
                `Available: ${available}.${suggestionLine}\n` +
                `Rerun ${localAssimilateRoleCommand(apiUrl)} with one of the available roles.\n`);
            return { kind: 'stop', code: 1 };
        }
    }
    else {
        const occupiedRoleIds = occupiedRoleIdsForAutoRole(cubeDetail.drones ?? []);
        resolvedRole = pickDefaultRole(cubeDetail.roles, { isFirstDrone, occupiedRoleIds });
        if (!resolvedRole) {
            deps.stderr(`Cube "${cubeDetail.name}" on ${apiUrl} has no default or human-seat role. ` +
                `Ask the server operator to configure a role, then rerun ` +
                `${localAssimilateRoleCommand(apiUrl)}.\n`);
            return { kind: 'stop', code: 1 };
        }
    }
    const effectiveModel = flags.model ?? null;
    const cli = await deps.resolveCli(flags.cli);
    try {
        ensureCliMcpConfigured(cli);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.stderr(`${cli} MCP configuration failed for ${apiUrl}: ${safeStderr(message)}. ` +
            `Fix the ${cli} MCP configuration, then rerun ${localAssimilateCliCommand(apiUrl, cli)}.\n`);
        return { kind: 'stop', code: 1 };
    }
    return continueAssimilation({ resolvedRole, effectiveModel, cli });
}
export async function prepareAssimilationSeat(input, deps) {
    const { apiUrl, token, serverTrustIdentity, cubeDetail, resolvedRole, cli, effectiveModel, projectRoot, existing, reattachPriorId, remintInvalidPrior, resumeCredentialRef, resumeDroneId, resumeState, sessionOperation, } = input;
    let sessionExpected;
    if (resumeCredentialRef && resumeState === 'pending') {
        sessionExpected = { kind: 'absent' };
    }
    else if (resumeCredentialRef) {
        sessionExpected = {
            kind: 'exact',
            credentialRef: resumeCredentialRef,
            ...(resumeDroneId ? { droneId: resumeDroneId } : {}),
        };
    }
    else if (remintInvalidPrior && existing?.localSessionCredentialRef) {
        sessionExpected = {
            kind: 'exact',
            credentialRef: existing.localSessionCredentialRef,
            ...(existing.droneId ? { droneId: existing.droneId } : {}),
        };
    }
    else if (reattachPriorId != null && existing?.localSessionCredentialRef && existing.sessionToken) {
        sessionExpected = {
            kind: 'exact',
            credentialRef: existing.localSessionCredentialRef,
            ...(existing.droneId ? { droneId: existing.droneId } : {}),
            sessionDigest: createHash('sha256').update(existing.sessionToken).digest('hex'),
        };
    }
    else {
        sessionExpected = { kind: 'absent' };
    }
    deps.stderr(`Joining cube '${cubeDetail.name}' as ${resolvedRole.name}…\n`);
    let result;
    try {
        result = await deps.assimilate(apiUrl, token, {
            cube_id: cubeDetail.id,
            role_id: resolvedRole.id,
            hostname: deps.getHostname(),
            agent_kind: cli,
            model: effectiveModel,
            working_repo: resolveWorkingRepo(projectRoot),
            ...(reattachPriorId ? { prior_drone_id: reattachPriorId } : {}),
            ...(remintInvalidPrior ? { remint_invalid_prior: true } : {}),
            session_operation: sessionOperation,
            session_expected: sessionExpected,
            revalidate_at_prepare: true,
        }, serverTrustIdentity);
    }
    catch (error) {
        if (error instanceof DroneEvictedError && reattachPriorId != null) {
            deps.stderr(`This worktree's drone on ${apiUrl} was evicted. ` +
                `Remove this worktree, or from a fresh worktree run ${localAssimilateCommand(apiUrl)}.\n`);
            return { kind: 'stop', code: 1 };
        }
        if (error instanceof BorgServerError && reattachPriorId != null) {
            if (error.code === 'SESSION_REVOKED') {
                return { kind: 'stop', code: diagnoseSessionTermination(deps, apiUrl, 'revoked') };
            }
            if (error.code === 'SESSION_REJECTED') {
                return { kind: 'stop', code: diagnoseSessionTermination(deps, apiUrl, 'superseded') };
            }
        }
        return { kind: 'stop', code: await reportServerFailure(deps, apiUrl, error) };
    }
    if (result.prepareAborted) {
        deps.stderr(`This worktree's saved connection to ${apiUrl} changed before the attach ` +
            '(a concurrent reset or enroll); no credential was created or sent and nothing was ' +
            `changed. Re-run ${localAssimilateCommand(apiUrl)} to attach against the current state.\n`);
        return { kind: 'stop', code: 1 };
    }
    if (result.local_session === undefined) {
        return {
            kind: 'stop',
            code: await reportServerFailure(deps, apiUrl, new Error('Borg server did not return compatible secure session metadata')),
        };
    }
    const assignedRole = cubeDetail.roles.find((role) => role.id === result.role_id) ?? resolvedRole;
    if (result.result === 'reused') {
        deps.stderr(`re-attached as ${result.drone_label} (same session, no new drone minted)\n`);
    }
    else if (assignedRole.id !== resolvedRole.id) {
        deps.stderr(`The requested role "${resolvedRole.name}" was unavailable; ` +
            `attached under the "${assignedRole.name}" role instead.\n`);
    }
    return continueAssimilation({ result, assignedRole, sessionExpected });
}
export async function prepareAssimilationWorktree(input, deps) {
    const { flags, repositoryContext, projectRoot, wantSibling, verifiedHead, assignedRole, existing } = input;
    let spawnedWorktreePath = null;
    if (!wantSibling)
        return continueAssimilation({ spawnedWorktreePath });
    const originProbe = deps.runSync('git', ['remote', 'get-url', 'origin'], projectRoot);
    let startRef = 'HEAD';
    if (originProbe.status === 0 && originProbe.stdout.trim().length > 0) {
        deps.runSync('git', ['fetch', 'origin'], projectRoot);
        const mainProbe = deps.runSync('git', ['rev-parse', '--verify', 'origin/main'], projectRoot);
        if (mainProbe.status === 0) {
            startRef = 'origin/main';
        }
        else if (deps.runSync('git', ['rev-parse', '--verify', 'origin/master'], projectRoot).status === 0) {
            startRef = 'origin/master';
        }
    }
    if (startRef === 'HEAD') {
        const handoverMode = repositoryContext.publicRepository === null
            ? 'local handover mode'
            : 'no usable origin';
        deps.stderr(`note: ${handoverMode}; new worktree will start on local HEAD (${verifiedHead.slice(0, 7)})\n`);
    }
    else {
        const remoteHead = deps.runSync('git', ['rev-parse', startRef], projectRoot).stdout.trim();
        if (verifiedHead !== remoteHead) {
            deps.stderr(`note: local HEAD (${verifiedHead.slice(0, 7)}) differs from ${startRef} (${remoteHead.slice(0, 7)}); ` +
                `new worktree will start on ${startRef}\n`);
        }
    }
    const repoBase = basename(dirname(repositoryContext.commonDir));
    const suffix = flags.worktree ?? roleSlug(assignedRole.name);
    if (suffix.length === 0) {
        deps.stderr(`cannot derive a worktree name from role "${assignedRole.name}"; ` +
            'pass an explicit --worktree <name>\n');
        return { kind: 'stop', code: 1 };
    }
    const homeDir = deps.homedir();
    let registeredWorktrees = listRegisteredWorktrees(deps, projectRoot);
    if (registeredWorktrees === null) {
        deps.stderr('Borg could not enumerate this repository’s existing worktrees, so it did not risk creating a colliding sibling.\n' +
            'Run `git worktree list` from this repository and resolve the reported Git error, then rerun `borg assimilate`.\n' +
            'A local drone reservation was created and remains pending; rerunning after fixing the worktree issue resumes that reservation.\n');
        return { kind: 'stop', code: 1 };
    }
    let candidate = computeWorktreePath(homeDir, repoBase, suffix);
    let worktreeBranch = perWorktreeBranchName(basename(candidate), repoBase);
    let suffixNumber = 2;
    while (deps.pathExists(candidate) ||
        registeredWorktrees.names.has(basename(candidate)) ||
        registeredWorktrees.branches.has(worktreeBranch) ||
        (localBranchExists(deps.runSync, projectRoot, worktreeBranch) &&
            !isMerged(deps.runSync, projectRoot, worktreeBranch, startRef))) {
        candidate = computeWorktreePath(homeDir, repoBase, suffix, suffixNumber);
        worktreeBranch = perWorktreeBranchName(basename(candidate), repoBase);
        suffixNumber++;
    }
    let worktreeResult;
    let residualBranch = null;
    while (true) {
        deps.mkdirp(dirname(candidate));
        const branchExisted = localBranchExists(deps.runSync, projectRoot, worktreeBranch);
        worktreeResult = branchExisted
            ? deps.runSync('git', ['worktree', 'add', candidate, worktreeBranch], projectRoot)
            : deps.runSync('git', ['worktree', 'add', '-b', worktreeBranch, candidate, startRef], projectRoot);
        if (worktreeResult.status === 0)
            break;
        const refreshed = listRegisteredWorktrees(deps, projectRoot);
        const branchAppeared = !branchExisted && localBranchExists(deps.runSync, projectRoot, worktreeBranch);
        const collision = deps.pathExists(candidate) ||
            refreshed?.names.has(basename(candidate)) === true ||
            refreshed?.branches.has(worktreeBranch) === true ||
            (!branchExisted && worktreeAddReportedCollision(worktreeResult.stderr));
        if (!collision || refreshed === null) {
            if (branchAppeared && refreshed?.branches.has(worktreeBranch) !== true)
                residualBranch = worktreeBranch;
            break;
        }
        registeredWorktrees = refreshed;
        do {
            candidate = computeWorktreePath(homeDir, repoBase, suffix, suffixNumber);
            worktreeBranch = perWorktreeBranchName(basename(candidate), repoBase);
            suffixNumber++;
        } while (deps.pathExists(candidate) ||
            registeredWorktrees.names.has(basename(candidate)) ||
            registeredWorktrees.branches.has(worktreeBranch) ||
            localBranchExists(deps.runSync, projectRoot, worktreeBranch));
    }
    if (worktreeResult.status !== 0) {
        deps.stderr(`Borg could not create sibling worktree ${candidate} on branch ${worktreeBranch}. ` +
            `Git reported: ${safeStderr(worktreeResult.stderr)}\n` +
            (residualBranch
                ? `Git left branch ${residualBranch} without a registered worktree; Borg preserved it.\n`
                : '') +
            'Run `git worktree list` and `git status` to inspect repository state, resolve the reported Git error, then rerun `borg assimilate`.\n' +
            'A local drone reservation was created and remains pending; rerunning after fixing the worktree issue resumes that reservation.\n');
        return { kind: 'stop', code: 1 };
    }
    deps.stderr(`spawned sibling worktree at ${candidate} on branch ${worktreeBranch} (${startRef})` +
        (existing !== null
            ? '; the original dir keeps its active drone binding — run `borg reset-local-connection` there if that binding is stale.\n'
            : '.\n'));
    deps.chdir(candidate);
    deps.stderr(renderWorktreeSteeringNote(candidate, worktreeBranch, projectRoot));
    spawnedWorktreePath = deps.cwd();
    return continueAssimilation({ spawnedWorktreePath });
}
export async function resolveAssimilationAuthority(input, deps) {
    const { args, mode, repositoryContext } = input;
    const hostlessEnrollment = args.flags.enroll === true &&
        args.flags.server === undefined && deps.defaultAuthority === undefined;
    const artifactOnlyEnrollment = hostlessEnrollment && deps.isTTY();
    let preResumeAttempted = false;
    let preResumedEnrollment = null;
    let prefetchedInvitation;
    let prefetchedArtifact;
    if (hostlessEnrollment && !deps.isTTY()) {
        deps.stderr('Local enrollment requires an interactive operator terminal. ' +
            `Re-run ${localAssimilateCommand(undefined, true, mode)} from the operator’s terminal.\n`);
        return { kind: 'stop', code: 1 };
    }
    if (args.flags.enroll && args.flags.server !== undefined && deps.isTTY()) {
        let preResumeOrigin;
        try {
            preResumeOrigin = normalizeServerEndpoint(args.flags.server);
        }
        catch (error) {
            deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
            return { kind: 'stop', code: 1 };
        }
        prefetchedInvitation = await deps.promptSecret('Enrollment invitation (single-use; hidden input):');
        if (!prefetchedInvitation) {
            deps.stderr('No enrollment invitation was entered. Ask the server operator for one, then retry.\n');
            return { kind: 'stop', code: 1 };
        }
        try {
            prefetchedArtifact = decodeAndVerifyInvitationArtifact(prefetchedInvitation);
            if (prefetchedArtifact.endpoint !== preResumeOrigin) {
                throw new InvitationArtifactEndpointMismatchError(preResumeOrigin, prefetchedArtifact.endpoint);
            }
        }
        catch (error) {
            deps.stderr(`${error instanceof Error ? error.message : 'The enrollment invitation is invalid.'}\n`);
            return { kind: 'stop', code: 1 };
        }
        let pendingForHost = false;
        if (deps.peekPendingServerEnrollment) {
            let pending = null;
            try {
                pending = await deps.peekPendingServerEnrollment();
            }
            catch {
                pending = null;
            }
            if (pending?.origin === preResumeOrigin) {
                try {
                    const pendingArtifact = decodeAndVerifyInvitationArtifact(pending.invitation);
                    if (pendingArtifact.endpoint !== preResumeOrigin) {
                        throw new InvitationArtifactEndpointMismatchError(preResumeOrigin, pendingArtifact.endpoint);
                    }
                    pendingForHost = true;
                }
                catch (error) {
                    deps.stderr(`${error instanceof Error ? error.message : 'The enrollment invitation is invalid.'}\n`);
                    return { kind: 'stop', code: 1 };
                }
            }
        }
        if (pendingForHost) {
            try {
                preResumeAttempted = true;
                preResumedEnrollment = await deps.resumeServerEnrollment(preResumeOrigin, () => {
                    deps.stderr(`Resuming the pending enrollment for \`${preResumeOrigin}\`; ` +
                        'do not enter another invitation unless the server certificate was reissued; ' +
                        'if it was, request a current invitation and rerun this command.\n');
                });
            }
            catch {
                preResumeAttempted = false;
            }
        }
    }
    if (artifactOnlyEnrollment || preResumeAttempted && preResumedEnrollment === null) {
        if (artifactOnlyEnrollment && deps.resumePendingServerEnrollment) {
            preResumedEnrollment = await deps.resumePendingServerEnrollment(() => {
                deps.stderr('Resuming the pending enrollment; no new invitation is required.\n');
            });
        }
        if (!(artifactOnlyEnrollment && preResumedEnrollment)) {
            prefetchedInvitation = await deps.promptSecret('Enrollment invitation (single-use; hidden input):');
            if (!prefetchedInvitation) {
                deps.stderr('No enrollment invitation was entered. Ask the server operator for one, then retry.\n');
                return { kind: 'stop', code: 1 };
            }
            try {
                prefetchedArtifact = decodeAndVerifyInvitationArtifact(prefetchedInvitation);
            }
            catch (error) {
                deps.stderr(`${error instanceof Error ? error.message : 'The enrollment invitation is invalid.'}\n`);
                return { kind: 'stop', code: 1 };
            }
        }
    }
    if (!artifactOnlyEnrollment && args.flags.server === undefined && deps.defaultAuthority === undefined) {
        const connectCommand = mode === 'cube-init'
            ? 'borg server cube init --host <host>'
            : 'borg assimilate --host <host>';
        const serverInstall = await deps.ensureLocalServerInstalled(connectCommand);
        if (serverInstall !== 'present') {
            return { kind: 'stop', code: serverInstall === 'installed' ? 0 : 1 };
        }
    }
    try {
        await deps.preparePrivateRoot();
    }
    catch {
        deps.stderr(`${PRIVATE_STATE_UNAVAILABLE_COPY}\n`);
        return { kind: 'stop', code: 1 };
    }
    let existing = null;
    let hasPersistedIdentity = false;
    let localSeatReadError;
    try {
        existing = await deps.getActiveCube();
        hasPersistedIdentity = existing !== null || await deps.hasPersistedActiveCube();
    }
    catch (error) {
        if (error instanceof LegacySessionCredentialCollisionError) {
            return { kind: 'stop', code: await reportServerFailure(deps, error.origin, error, false, mode) };
        }
        localSeatReadError = error;
    }
    const selectedAuthority = await selectAssimilationAuthority(args.flags, deps, mode);
    if (!selectedAuthority)
        return { kind: 'stop', code: 1 };
    let authority = selectedAuthority;
    if (localSeatReadError !== undefined) {
        return { kind: 'stop', code: await reportServerFailure(deps, authority.apiUrl, localSeatReadError, false, mode) };
    }
    const projectRoot = repositoryContext.root;
    const wantSibling = args.flags.worktree !== undefined ||
        (!args.flags.here && !(existing === null && hasPersistedIdentity));
    let verifiedHead = '';
    if (mode !== 'cube-init' && args.flags.here && existing === null && !hasPersistedIdentity) {
        deps.stderr('`borg assimilate --here` resumes this worktree\'s saved drone, but no saved drone was found.\n' +
            'Run `borg assimilate` to create a new drone in a managed worktree.\n');
        return { kind: 'stop', code: 1 };
    }
    if (mode !== 'cube-init' && wantSibling) {
        const headProbe = deps.runSync('git', ['rev-parse', '--verify', 'HEAD'], projectRoot);
        if (headProbe.status !== 0) {
            deps.stderr('sibling worktree spawn requires HEAD pointing at a commit.\n' +
                'Create an initial commit (for example: `git commit --allow-empty -m "Initial commit"`), then rerun `borg assimilate`.\n');
            return { kind: 'stop', code: 1 };
        }
        verifiedHead = headProbe.stdout.trim();
    }
    let auth;
    try {
        let serverAuth;
        if (args.flags.enroll) {
            if (!deps.isTTY()) {
                deps.stderr('Local enrollment requires an interactive operator terminal. ' +
                    `Re-run ${localAssimilateCommand(authority.apiUrl, true, mode)} from the operator’s terminal.\n`);
                return { kind: 'stop', code: 1 };
            }
            let resumed = preResumedEnrollment;
            if (!resumed && prefetchedArtifact === undefined && !preResumeAttempted && !artifactOnlyEnrollment) {
                resumed = await deps.resumeServerEnrollment(authority.apiUrl, () => {
                    deps.stderr(`Resuming the pending enrollment for \`${authority.apiUrl}\`; ` +
                        'do not enter another invitation unless the server certificate was reissued; ' +
                        'if it was, request a current invitation and rerun this command.\n');
                });
            }
            if (resumed) {
                if (resumed.apiUrl)
                    authority = { kind: 'server', apiUrl: resumed.apiUrl };
                serverAuth = resumed;
            }
            else {
                let invitation = prefetchedInvitation ?? await deps.promptSecret(artifactOnlyEnrollment
                    ? 'Enrollment invitation (single-use; hidden input):'
                    : `Enrollment invitation for \`${authority.apiUrl}\` (single-use; hidden input):`);
                if (!invitation) {
                    deps.stderr(artifactOnlyEnrollment
                        ? 'No enrollment invitation was entered. Ask the server operator for one, then rerun `borg assimilate --enroll`.\n'
                        : `No enrollment invitation was entered for ${authority.apiUrl}. Ask the server operator for one, then rerun ${localAssimilateCommand(authority.apiUrl, true, mode)}.\n`);
                    return { kind: 'stop', code: 1 };
                }
                try {
                    const artifact = prefetchedArtifact ?? decodeAndVerifyInvitationArtifact(invitation);
                    if (args.flags.server !== undefined && authority.apiUrl !== artifact.endpoint) {
                        throw new InvitationArtifactEndpointMismatchError(authority.apiUrl, artifact.endpoint);
                    }
                    authority = { kind: 'server', apiUrl: artifact.endpoint };
                    serverAuth = await deps.connectServer(authority.apiUrl, {
                        invitation,
                        artifact,
                        confirmReplacement: async () => strictAffirmative(await deps.prompt(`A local enrollment for ${authority.apiUrl} already exists. Replacing it will orphan ` +
                            'the first enrolled client. Replace it? [y/N]: ')),
                    });
                }
                finally {
                    invitation = '';
                }
            }
            deps.stderr(serverAuth.serverCapabilities?.includes('create_cube')
                ? `Owner client enrolled with \`${authority.apiUrl}\`. Creating or joining this repository’s cube next.\n`
                : `Ordinary client enrolled with \`${authority.apiUrl}\`. Checking for an accessible repository cube next.\n`);
        }
        else {
            serverAuth = await deps.connectServer(authority.apiUrl);
        }
        auth = {
            token: serverAuth.token,
            apiUrl: authority.apiUrl,
            serverTrustIdentity: serverAuth.trustIdentity,
            serverCapabilities: serverAuth.serverCapabilities ?? [],
        };
        if (args.flags.enroll) {
            deps.stderr(`This machine (${deps.getHostname()}) is enrolled with Borg server \`${authority.apiUrl}\`.\n`);
        }
    }
    catch (error) {
        return {
            kind: 'stop',
            code: await reportServerFailure(deps, authority.apiUrl, error, args.flags.enroll === true, mode),
        };
    }
    return continueAssimilation({
        authority,
        auth,
        existing,
        hasPersistedIdentity,
        projectRoot,
        wantSibling,
        verifiedHead,
    });
}
export async function runAssimilate(args, deps, options = {}) {
    const repository = await resolveAssimilationRepository(args, deps);
    if (repository.kind === 'stop')
        return repository.code;
    const { mode, repositoryContext } = repository.value;
    const authorityResolution = await resolveAssimilationAuthority({ args, mode, repositoryContext }, deps);
    if (authorityResolution.kind === 'stop')
        return authorityResolution.code;
    const { authority, auth, existing, hasPersistedIdentity, projectRoot, wantSibling, verifiedHead, } = authorityResolution.value;
    // ----- Sprint 19 (gh#184): Reorder for strict-rollback semantics. -----
    // The previous flow created a sibling worktree (FS state) BEFORE
    // role resolution + API assimilate. Any early-return between
    // worktree-spawn and API success orphaned the worktree (gh#184
    // canonical case: unknown role arg). The new flow defers all FS
    // state until AFTER the API assimilate succeeds — early-return at
    // role resolution / listCubes / createCube / template-prompt /
    // template-invalid-choice is now structurally clean (no orphan
    // class possible). Worktree rollback narrows to local finalization failures
    // after worktree creation.
    // Sprint 18: capture pre-chdir cwd for the post-exit shell-cd hint
    // (no chdir has happened yet; this is a stable starting point).
    const originalCwd = deps.cwd();
    let initialized;
    try {
        initialized = await initializeRepositoryCube({
            mode,
            context: repositoryContext,
            serverOrigin: auth.apiUrl,
            flags: args.flags,
            canCreate: auth.serverCapabilities.includes('create_cube'),
        }, {
            isTTY: deps.isTTY,
            prompt: deps.prompt,
            write: deps.stderr,
            ...(mode === 'cube-init' ? { writeResult: deps.stdout } : {}),
            useColor: () => deps.isTTY() && !process.env.NO_COLOR && !process.env.CI,
            getIdentity: deps.getRepositoryIdentity,
            getAssociation: (repository) => deps.getRepositoryAssociation(auth.serverTrustIdentity, repository),
            saveAssociation: (repository, association) => deps.saveRepositoryAssociation(auth.serverTrustIdentity, repository, association),
            resolveAssociation: (repository, workingRepoName) => deps.resolveRepositoryCube(auth.apiUrl, auth.token, { repository, workingRepoName }, auth.serverTrustIdentity),
            listCubes: () => deps.listCubes(auth.apiUrl, auth.token, auth.serverTrustIdentity),
            associateCube: (params) => deps.associateRepositoryCube(auth.apiUrl, auth.token, params, auth.serverTrustIdentity),
            getCube: (cubeId) => deps.getCube(auth.apiUrl, auth.token, cubeId, auth.serverTrustIdentity),
            createCube: (params) => deps.createCube(auth.apiUrl, auth.token, params, auth.serverTrustIdentity),
        });
    }
    catch (error) {
        if (error instanceof RepositoryAssociationOutcomeUnknownError) {
            deps.stderr('Repository cube association outcome is unknown.\n' +
                'The server may have created the repository binding; no local repository association was saved and no drone was created.\n' +
                'Run the same command again; Borg will first resolve the authoritative server association without creating a cube.\n');
            return 1;
        }
        if (error instanceof RepositoryAssociationResolutionError) {
            deps.stderr('Repository cube association could not be resolved.\n' +
                'Verify that the server is reachable and the client and server versions match, then run the same command again.\n' +
                'No cube, repository binding, or drone was created.\n');
            return 1;
        }
        if (error instanceof RepositoryAssociationOperationError) {
            const recovery = error.failure === 'repository-already-associated'
                ? 'This repository is already associated with another cube. The selected cube grant is valid, but it cannot replace that existing repository binding. Run the same command again to use the existing managed association, or ask the server operator to correct the repository binding.'
                : error.failure === 'cube-already-associated'
                    ? 'The selected cube is already associated with another repository. Choose a different cube, or run the command from the repository already linked to that cube.'
                    : error.failure === 'access-denied'
                        ? 'This enrolled client does not have permission to manage the selected cube. Ask the server operator to grant this client management access, then run the same command again.'
                        : 'The selected cube does not have valid authoritative roles. Ask the server operator to repair its role configuration, or choose another cube.';
            deps.stderr('Repository cube association could not be completed.\n' +
                `${recovery}\n` +
                'No cube, repository binding, or drone was created.\n');
            return 1;
        }
        if (error instanceof RepositoryAssociationConfirmationError) {
            deps.stderr('Repository cube association could not be confirmed.\n' +
                'The server may have created the repository binding; no local repository association was saved and no drone was created.\n' +
                'Run the same command again; Borg will resolve authoritative server state before creating or associating a cube.\n');
            return 1;
        }
        if (error instanceof RepositoryAssociationSaveError) {
            deps.stderr('The repository cube was confirmed, but Borg could not save its local repository association.\n' +
                'No drone was created.\n' +
                'Run the same command again; the server will resolve the existing cube and restore the local association.\n');
            return 1;
        }
        if (error instanceof CubeCreationOutcomeUnknownError) {
            deps.stderr('Cube creation outcome is unconfirmed.\n' +
                'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
                'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n');
            return 1;
        }
        if (error instanceof CubeCreationConfirmationError) {
            deps.stderr('Cube creation could not be confirmed.\n' +
                'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
                'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n');
            return 1;
        }
        if (error instanceof BorgServerError && error.code === 'CREATE_CUBE_DENIED') {
            deps.stderr(`This enrolled client cannot create a cube on ${auth.apiUrl}. ` +
                `Ask the server operator to grant access to a cube, then rerun ${localAssimilateCommand(auth.apiUrl, false, mode)}.\n`);
            return 1;
        }
        if (error instanceof BorgServerError) {
            return await reportServerFailure(deps, auth.apiUrl, error, false, mode);
        }
        deps.stderr('Repository cube initialization failed.\n' +
            'The server may have created or associated a cube; local repository state may be incomplete and no drone was created.\n' +
            'Run the same command again; Borg will resolve authoritative server state before creating or associating a cube.\n');
        return 1;
    }
    if (initialized.kind === 'stop')
        return initialized.code;
    const cubeDetail = initialized.creation.cube;
    const isFirstDrone = (cubeDetail.drones?.length ?? 0) === 0;
    if (mode === 'cube-init')
        return 0;
    // Read the worktree identity before role selection. A live local seat must
    // retain its original role so the attach request reuses the exact durable
    // retry binding instead of selecting another unoccupied role and minting a
    // duplicate seat.
    // `let`: the bound-pending resume path (CR#2) OVERRIDES this from the stored
    // operation so a rerun re-derives the EXACT original sibling seat ref.
    let sessionOperation = {
        // Capture the source repository before a successful sibling attach changes
        // cwd. This is the stable seat/sibling namespace for the pending bearer, so a
        // deliberate sibling never collides with the durable in-place seat's bearer.
        projectRoot,
        kind: 'sibling',
        // CR1(a): an implicit sibling's operation key must be COLLISION-SAFE — two
        // unnamed siblings of the same (origin,trust,cube,role) must get DISTINCT seat
        // refs, else prepareSeat reuses the first sibling's ACTIVE record and the
        // activate+bind step overwrites its worktree (an active seat silently unseated
        // and rebound). A named sibling already keys on its name; an unnamed one derives
        // a per-invocation-unique key so every distinct implicit sibling target mints a
        // distinct bearer / seat ref.
        operationKey: args.flags.worktree === undefined
            ? `implicit-sibling:${randomUUID()}`
            : `named-sibling:${args.flags.worktree}`,
    };
    // A selected sibling can be the surviving live seat for this worktree (#63).
    // `--here` must re-send that seat's durable operation, not reconstruct the
    // in-place operation and then fail PREPARE forever on the wrong ref.
    if (existing && args.flags.here && existing.operation) {
        sessionOperation = existing.operation;
    }
    let reattachPriorId;
    let remintInvalidPrior = false;
    let savedLocalRole;
    // Set when the pre-attach gate recovers a crash-in-gap PENDING seat: the
    // composite FINALIZE must then declare EXACT-ref (the credential is pending,
    // not active, so no live-bearer digest is pinned) so it re-persists the extant
    // binding and flips pending→ACTIVE, rather than aborting on an ABSENT check.
    let resumeCredentialRef;
    let resumeDroneId;
    // CR#2: 'pending' when the resumed record is a bound-PENDING sibling (activation
    // failed) — it re-sends the identical bearer under an ABSENT/pending-reuse
    // expectation; 'active' when resuming a live in-place seat (EXACT expectation).
    let resumeState;
    if (existing && args.flags.here && existing.cubeId !== cubeDetail.id) {
        deps.stderr(`This directory already hosts an active drone for another cube on ${authority.apiUrl}. ` +
            `Remove \`--here\` or use a fresh worktree, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
        return 1;
    }
    if (authority.kind === 'server') {
        // CR#3: recover an in-flight IMPLICIT-sibling attempt (persisted + collision-safe).
        // An implicit sibling mints a per-invocation-unique operationKey; a crash AFTER the
        // server accepts but BEFORE the worktree bind leaves an UNBOUND pending sibling
        // record whose random key would otherwise be undiscoverable — a rerun would mint a
        // NEW bearer and the server (digest-correlating) would create a GHOST seat. The
        // unbound pending sibling record IS the persisted attempt identity, discoverable by
        // source repo: adopt its EXACT operation (→ same seat ref) AND its role, and declare
        // a PENDING resume so prepareSeat REUSES the identical bearer (server reuses the
        // seat). Only for an IMPLICIT sibling (no --worktree name); a named sibling already
        // keys collision-safe on its name. Skipped once the attempt is bound/activated (it is
        // no longer an unbound pending sibling), so a completed sibling frees the key.
        if (wantSibling &&
            args.flags.worktree === undefined &&
            auth.serverTrustIdentity !== undefined &&
            deps.findIncompleteSiblingAttempt) {
            const inflight = await deps.findIncompleteSiblingAttempt({
                origin: auth.apiUrl,
                trustIdentity: auth.serverTrustIdentity,
                cubeId: cubeDetail.id,
                projectRoot,
            });
            if (inflight) {
                const inflightRole = cubeDetail.roles.find((role) => role.id === inflight.roleId);
                if (inflightRole) {
                    // Adopt the EXACT stored operation (same operationKey → same R_sib) + role, and
                    // resume PENDING so prepareSeat re-sends the identical bearer and converges.
                    sessionOperation = inflight.operation;
                    savedLocalRole = inflightRole;
                    resumeCredentialRef = inflight.credentialRef;
                    resumeState = 'pending';
                }
            }
        }
        if (!existing && hasPersistedIdentity) {
            // getActiveCube() is null AND metadata is persisted. Two distinct states:
            //   (a) crash-in-gap RESUME — the composite FINALIZE wrote the binding, then
            //       a crash/throw preceded the pending→ACTIVE flip. The credential is
            //       still a PENDING record (non-hydratable → getActiveCube null), the
            //       binding is intact, and re-sending the identical pending bearer
            //       converges. Ratified clause 4: this state is RERUNNABLE and must be
            //       truthfully reported, NOT misdiagnosed as keychain loss.
            //   (b) genuine keychain loss/lock — no record at the ref. Truthful error,
            //       and NEVER a new seat (record-absent invariant).
            // A pure PEEK (no create/mutate) at the deterministic per-seat ref
            // distinguishes them. Resume only applies to an in-place attach (a
            // --worktree sibling is a NEW seat, not a resume of this worktree's seat).
            const persisted = deps.readPersistedLocalSeat
                ? await deps.readPersistedLocalSeat()
                : null;
            let resumeRole;
            let recordPresent = false;
            if (persisted &&
                !wantSibling &&
                persisted.apiUrl === auth.apiUrl &&
                persisted.serverTrustIdentity === auth.serverTrustIdentity) {
                recordPresent = deps.peekServerSessionRecord
                    ? await deps.peekServerSessionRecord(persisted.localSessionCredentialRef, {
                        origin: auth.apiUrl,
                        trustIdentity: auth.serverTrustIdentity,
                        cubeId: persisted.cubeId,
                    })
                    : false;
                if (recordPresent && persisted.roleName) {
                    resumeRole = cubeDetail.roles.find((role) => role.name === persisted.roleName);
                }
            }
            if (persisted && recordPresent && resumeRole) {
                // RESUME: reuse the persisted role (the ref binds the role, so a resume MUST
                // re-derive the exact same account) and converge on the exact stored record.
                savedLocalRole = resumeRole;
                resumeCredentialRef = persisted.localSessionCredentialRef;
                resumeState = persisted.state;
                // CR#2: re-derive the EXACT pending seat ref from the STORED operation. A
                // bound-PENDING sibling's record still carries its ORIGINAL sibling operation
                // (projectRoot+kind+operationKey), NOT the rerun worktree's derived
                // current-worktree seat operation — overriding here makes the rerun
                // re-mint-or-reuse the identical pending bearer at the original R_sib and
                // converge (no ghost seat). For an ACTIVE in-place resume the stored operation
                // equals the already-derived one, so this is a no-op.
                sessionOperation = persisted.operation;
                // Only an ACTIVE resume pins the drone id (EXACT expectation below). A
                // bound-PENDING record declares ABSENT/pending-reuse and does not pin it.
                if (persisted.state === 'active' && persisted.droneId !== undefined) {
                    resumeDroneId = persisted.droneId;
                }
            }
            else {
                deps.stderr(`This worktree has a saved connection to ${authority.apiUrl}, but its local session ` +
                    'credential could not be loaded from the private store. No drone was created. Run ' +
                    `${resetLocalSeatCommand(authority.apiUrl)} to clear this worktree's saved connection, then ` +
                    `ask the operator for a new invitation and rerun ${localAssimilateCommand(authority.apiUrl, true)}.\n`);
                return 1;
            }
        }
        if (existing && args.flags.here &&
            (existing.apiUrl !== auth.apiUrl ||
                existing.serverTrustIdentity !== auth.serverTrustIdentity)) {
            deps.stderr(`This worktree's saved connection does not match ${authority.apiUrl}. ` +
                'No drone was created. Restore the expected server identity or use a fresh ' +
                `worktree, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
            return 1;
        }
        // The per-seat PENDING bearer is the resume mechanism: a lost attach
        // response is recovered when the next attach re-sends the identical bearer,
        // so there is no separate unfinished-attach store to scan. Reattach identity
        // for `--here` comes from this worktree's saved active cube below.
        if (existing && args.flags.here) {
            savedLocalRole = existing.roleName
                ? cubeDetail.roles.find((role) => role.name === existing.roleName)
                : undefined;
            const status = await deps.probeSeat(existing);
            // Canonical rotated/revoked path: a pin-matched 401 on THIS worktree's
            // saved bearer. PURE DIAGNOSIS — attach never mutates local state on a
            // rejection; it points at the offline `borg reset-local-connection` command.
            // Distinct from unreachable/404/5xx/trust-mismatch, which stay
            // indeterminate below.
            if (status === 'revoked') {
                return diagnoseSessionTermination(deps, auth.apiUrl, 'revoked');
            }
            if (status === 'rejected') {
                return diagnoseSessionTermination(deps, auth.apiUrl, 'superseded');
            }
            // CR #6: distinct causes get cause-accurate, non-destructive recovery —
            // never the generic "restart the server" advice.
            if (status === 'credential-rejected') {
                // The saved SESSION bearer was rejected WITHOUT the typed takeover code
                // (a bare/other 401). Non-destructive: re-enroll, never a seat reset.
                deps.stderr(`The saved enrollment for ${authority.apiUrl} was rejected. No drone was created ` +
                    `and nothing was changed. Re-enroll with ${localAssimilateCommand(authority.apiUrl, true)} ` +
                    'from the operator’s terminal.\n');
                return 1;
            }
            if (status === 'trust-mismatch') {
                // Terminal: the pinned identity changed. Restarting the server does NOT
                // fix it — verify this is the expected server / re-initialization.
                deps.stderr(`Borg could not verify the expected server identity for ${authority.apiUrl}. ` +
                    'No drone was created. Verify that this is the expected server; if it was ' +
                    're-initialized, restore the expected identity, then rerun ' +
                    `${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'endpoint-mismatch') {
                // CR5: a verified server returned 404 for the drone endpoint — a protocol /
                // client-server VERSION mismatch, not a transient blip. Restarting does not
                // fix it; align versions. Non-destructive: no seat created, nothing reset.
                deps.stderr(`Borg reached ${authority.apiUrl} but it did not recognize this worktree's drone ` +
                    'endpoint — the client and server versions are likely incompatible. No drone ' +
                    'was created and nothing was changed. Update the Borg client and/or server so ' +
                    `their versions match, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'server-failure') {
                // CR5: a verified server returned 5xx — its own internal error. Transient:
                // check the server, then retry. Non-destructive.
                deps.stderr(`Borg reached ${authority.apiUrl} but it returned a server error while verifying ` +
                    "this worktree's saved connection. No drone was created. Check the server (its logs / " +
                    `\`borg-mcp-server start\`), then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'unreachable' || status === 'indeterminate') {
                // CR5: transport failure / timeout (unreachable) or a genuinely ambiguous
                // failure (indeterminate) — both transient. Start or restart the server.
                deps.stderr(`Borg could not verify this worktree's saved connection to ${authority.apiUrl}. ` +
                    'No drone was created. Start or restart the server with ' +
                    `\`borg-mcp-server start\`, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'live' && !savedLocalRole) {
                deps.stderr(`Borg verified this worktree's saved connection to ${authority.apiUrl}, but its saved ` +
                    'role is unavailable. No drone was created. Ask the server operator to restore ' +
                    `the role, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            reattachPriorId = existing.droneId;
            remintInvalidPrior = status === 'evicted';
        }
    }
    else if (existing && args.flags.here) {
        if (existing.serverTrustIdentity !== undefined || existing.apiUrl !== auth.apiUrl) {
            deps.stderr('This worktree\'s saved connection belongs to a different Borg authority. ' +
                'No drone was created; use a fresh worktree.\n');
            return 1;
        }
        reattachPriorId = existing.droneId;
    }
    if (existing && reattachPriorId !== undefined && !args.flags.force) {
        const inboxPath = deps.getInboxPath(existing.cubeId, existing.droneId);
        const stateRoot = monitorStateRootForWorktree(projectRoot);
        const holder = (deps.inspectLiveInboxMonitor ?? inspectLiveInboxMonitor)(inboxPath, stateRoot);
        if (holder !== null) {
            deps.stderr(formatSeatReattachRefusal(holder, 'borg assimilate --here --force'));
            return 1;
        }
    }
    const cubeRole = await resolveAssimilationCubeRole({
        requestedRole: args.role,
        flags: args.flags,
        cubeDetail,
        isFirstDrone,
        savedLocalRole,
        apiUrl: authority.apiUrl,
    }, deps);
    if (cubeRole.kind === 'stop')
        return cubeRole.code;
    const { resolvedRole, effectiveModel, cli } = cubeRole.value;
    const seat = await prepareAssimilationSeat({
        apiUrl: auth.apiUrl,
        token: auth.token,
        serverTrustIdentity: auth.serverTrustIdentity,
        cubeDetail,
        resolvedRole,
        cli,
        effectiveModel,
        projectRoot,
        existing,
        reattachPriorId,
        remintInvalidPrior,
        resumeCredentialRef,
        resumeDroneId,
        resumeState,
        sessionOperation,
    }, deps);
    if (seat.kind === 'stop')
        return seat.code;
    const { result, assignedRole, sessionExpected } = seat.value;
    const worktree = await prepareAssimilationWorktree({
        flags: args.flags,
        repositoryContext,
        projectRoot,
        wantSibling,
        verifiedHead,
        assignedRole,
        existing,
    }, deps);
    if (worktree.kind === 'stop')
        return worktree.code;
    const { spawnedWorktreePath } = worktree.value;
    // ----- Step 7b: provision launch access before persisting/launching -----
    // The launched process gets its current worktree plus a stable, disposable
    // per-seat scratch root. Codex also receives an external Git common directory
    // at launch so linked worktrees can update shared repository metadata.
    // Provision before FINALIZE so a failure cannot leave a saved seat without
    // its promised path grants.
    const agentCwd = deps.cwd(); // post-chdir if step 3 spawned a worktree
    const seatWorktree = deps.findProjectRoot(agentCwd);
    const monitorStateRoot = monitorStateRootForWorktree(seatWorktree);
    const scratchRoot = scratchRootForSeat(deps.homedir(), result.drone_label, result.drone_id);
    const launchAccessPaths = {
        // Access is granted at the repository root even when the harness starts in
        // a nested package. The launch cwd remains the operator's chosen subdir.
        worktree: seatWorktree,
        scratch: scratchRoot,
        commonDir: repositoryContext.commonDir,
    };
    // ----- Step 8: persist the binding (narrow rollback — worktree exists if spawned) -----
    const activeCube = {
        cubeId: result.cube_id,
        droneId: result.drone_id,
        name: cubeDetail.name,
        droneLabel: result.drone_label,
        apiUrl: auth.apiUrl,
        serverTrustIdentity: auth.serverTrustIdentity,
        localSessionCredentialRef: result.local_session.credential_ref,
        // gh#899: persist the assimilated role so the connect-time ListTools
        // handler can role-scope the native tool surface.
        roleName: assignedRole.name,
        isHumanSeat: assignedRole.is_human_seat,
        ...(assignedRole.role_class ? { roleClass: assignedRole.role_class } : {}),
    };
    const rollbackWorktree = () => {
        if (!spawnedWorktreePath)
            return;
        const rm = deps.runSync('git', ['worktree', 'remove', '--force', spawnedWorktreePath], projectRoot);
        if (rm.status === 0) {
            deps.stderr(`rolled back spawned worktree at ${spawnedWorktreePath}\n`);
        }
        else {
            deps.stderr(`manual cleanup needed: \`git worktree remove --force ${spawnedWorktreePath}\` ` +
                `(rollback attempt failed: ${safeStderr(rm.stderr).trim() || 'unknown'})\n`);
        }
    };
    // CLI resolution happens before the server attach because agent_kind is part
    // of that request. The resolver therefore saved the preference against the
    // invoking checkout. Once a sibling exists, save the same choice under its
    // own project key so a later --here launch in that worktree can read it.
    if (spawnedWorktreePath) {
        try {
            await deps.setCliPreferenceForWorktree(cli, spawnedWorktreePath);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.stderr(`Borg could not save the ${cli} preference for sibling worktree ${spawnedWorktreePath}: ${message}. ` +
                'The worktree was removed; correct the local configuration and retry.\n');
            rollbackWorktree();
            return 1;
        }
    }
    try {
        deps.mkdirp(scratchRoot);
        deps.provisionLaunchAccess?.(cli, seatWorktree, launchAccessPaths);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.stderr(`Borg could not pre-authorize the ${cli} launch paths: ${message}. ` +
            'No agent was launched; correct the local configuration and retry.\n');
        rollbackWorktree();
        return 1;
    }
    const finalization = await finalizeAssimilationSeat({
        activeCube,
        apiUrl: auth.apiUrl,
        repositoryContext,
        result,
        sessionExpected,
        rollbackWorktree,
    }, deps);
    if (finalization.kind === 'stop')
        return finalization.code;
    if (repositoryContext.publicRepository && deps.hasActiveSeatInDifferentCloneFamily) {
        try {
            if (await deps.hasActiveSeatInDifferentCloneFamily(result.cube_id, repositoryContext.publicRepository.value, repositoryContext.commonDir)) {
                deps.stderr('warning: this cube already has a seat from a different clone family. ' +
                    'All seats for a repository use worktrees from the same clone family, sharing its object database and refs.\n');
            }
        }
        catch {
            // This comparison is advisory and must never block assimilation.
        }
    }
    // gh#793: best-effort GC of orphaned inbox files (evicted/dead drones) in the
    // cube just joined — lazy-on-assimilate, no cron/new command. NEVER blocks or
    // fails the assimilate (whole call swallowed). Local-only signal (CubeDetail
    // carries no roster → droneState 'absent'; an inbox is reaped only when
    // no-live-holder AND ≥30-day stale). The live-safety gate (raw pgrep tail /
    // fresh heartbeat / live pidfile) vetoes any live holder — a wrong delete is
    // permanent deafness, a missed orphan is harmless.
    try {
        const livenessDeps = defaultInboxLivenessDeps();
        const cubeInboxDir = dirname(inboxPathForDrone(result.cube_id, result.drone_id));
        gcOrphanInboxesForCube({
            cubeInboxDir,
            selfDroneId: result.drone_id,
            deps: {
                listInboxLogs: defaultListInboxLogs,
                isLive: (p) => isInboxLive(p, livenessDeps, monitorStateRoot),
                droneState: () => 'absent',
                unlink: (p) => unlinkSync(p),
                now: livenessDeps.now,
                staleMs: ORPHAN_INBOX_STALE_MS,
            },
            monitorStateRoot,
        });
    }
    catch {
        /* gh#793: orphan GC is best-effort — never block or fail the assimilate */
    }
    // The project hook belongs to a prepared drone, not to the terminal handoff.
    // Quickstart suppresses only that handoff and later launches through launch-all.
    try {
        deps.installProjectSessionHook(agentCwd);
    }
    catch {
        deps.stderr(`warning: could not install the project-local SessionStart hook in ${agentCwd}; it will be re-attempted on the next borg launch\n`);
    }
    options.onPrepared?.({
        cubeId: result.cube_id,
        cubeName: cubeDetail.name,
        droneId: result.drone_id,
        droneLabel: result.drone_label,
        roleName: assignedRole.name,
        worktree: seatWorktree,
    });
    if (options.launch === false)
        return 0;
    return launchAssimilatedAgent({
        flags: args.flags,
        result,
        cubeDetail,
        assignedRole,
        apiUrl: auth.apiUrl,
        cli,
        effectiveModel,
        agentCwd,
        seatWorktree,
        scratchRoot,
        launchAccessPaths,
        monitorStateRoot,
        spawnedWorktreePath,
        originalCwd,
    }, deps);
}
function renderWorktreeSteeringNote(worktreePath, wtBranch, primaryPath) {
    return (`\nWORKTREE STEERING: You are in worktree ${worktreePath} on branch ${wtBranch}. ` +
        `Do ALL work HERE — cut your feature branch (fix/.../feat/...) off ${wtBranch} in THIS worktree, ` +
        `use relative paths / your cwd. NEVER \`git -C ${primaryPath}\` or operate on the primary checkout ${primaryPath}: ` +
        `the same branch can't be checked out in two worktrees, so work created in the primary won't reach your wt-branch ` +
        `without manual surgery (cherry-pick/merge).\n`);
}
/**
 * Sprint 4 / gh#147 (drone-8 SR-PE-FINDING-1): strip ASCII control
 * characters before interpolating subprocess stderr into operator-
 * facing messages. Defense-in-depth against a local attacker editing
 * `.git/config` to embed ANSI escapes (e.g. `\x1b[2J` cursor moves,
 * `\x1b]0;...\x07` title injection) — git command stderr then carries
 * them, and unfiltered orchestrator output corrupts the terminal.
 *
 * Strips `[\x00-\x1F\x7F]` (NUL, all C0 controls, DEL). ASCII
 * whitespace inside C0 (tab, newline, CR) gets stripped too — the
 * orchestrator only ever interpolates short status fragments where
 * preserving multi-line layout isn't load-bearing; over-strip
 * trade-off accepted for shape simplicity.
 */
export function safeStderr(msg) {
    return msg.replace(/[\x00-\x1F\x7F]/g, '');
}
function worktreeAddReportedCollision(stderr) {
    const message = safeStderr(stderr);
    return /(?:branch named .* already exists|already checked out|already registered|already exists at)/i.test(message);
}
function listRegisteredWorktrees(deps, projectRoot) {
    const res = deps.runSync('git', ['worktree', 'list', '--porcelain'], projectRoot);
    if (res.status !== 0)
        return null;
    const names = new Set();
    const branches = new Set();
    for (const line of res.stdout.split('\n')) {
        if (line.startsWith('worktree '))
            names.add(basename(line.slice('worktree '.length)));
        if (line.startsWith('branch refs/heads/'))
            branches.add(line.slice('branch refs/heads/'.length));
    }
    return { names, branches };
}
/**
 * Sprint 19 (gh#184): suggest the closest cube-role name for a misspelled
 * CLI role argument. Levenshtein distance ≤2 against the cube's role
 * names; case-insensitive. Returns null when no close match exists.
 *
 * Serves Queen's "more user-friendly" intent without violating the
 * Borg-collective metaphor (collective defines roles; drones slot in).
 * The original strict-failure semantic is preserved; the suggestion
 * is an additive nudge in the error message, not a fallback path.
 */
export function suggestRoleName(input, candidates) {
    if (candidates.length === 0)
        return null;
    const inputLower = input.toLowerCase();
    let best = null;
    for (const candidate of candidates) {
        const distance = levenshtein(inputLower, candidate.toLowerCase());
        if (distance <= 2 && (best === null || distance < best.distance)) {
            best = { name: candidate, distance };
        }
    }
    return best ? best.name : null;
}
/**
 * Minimal Levenshtein distance implementation. Used only by
 * `suggestRoleName` for the fuzzy-match nudge; intentionally
 * unexported and not a general-purpose helper.
 */
function levenshtein(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    const prev = new Array(b.length + 1);
    const curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++)
        prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++)
            prev[j] = curr[j];
    }
    return prev[b.length];
}
//# sourceMappingURL=assimilate-cmd.js.map