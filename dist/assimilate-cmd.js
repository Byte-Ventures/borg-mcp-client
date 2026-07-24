import { dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { roleSlug, matchRoleByName, occupiedRoleIdsForAutoRole, pickDefaultRole, } from './role-resolver.js';
import { deriveCubeName, parseGitRemote, sanitizeRemoteUrl } from './cube-name.js';
import { validateName } from './name-validator.js';
import { renderAssimilationWelcome } from './assimilate-welcome.js';
import { shellEscape } from './shell-escape.js';
import { withCodexCwdArg } from './codex-remote.js';
import { buildAgentKickoffPrompt, buildKickoffWakePathClause, recordCodexWakeTarget, socketPathFromRemoteArgs, } from './codex-launch.js';
import { perWorktreeBranchName, adoptWorktree, computeWorktreePath, localBranchExists, isMerged } from './worktree-lifecycle.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { codexBorgSessionConfigArgs } from './launch-gate.js';
import { codexAgentKindConfigArgs, codexRemoteWakeConfigArgs, withAgentRuntimeEnv, } from './agent-runtime.js';
import { inboxPathForDrone } from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import { resolveLaunchEnv } from './model-presets.js';
import { unlinkSync } from 'node:fs';
import { gcOrphanInboxesForCube, defaultListInboxLogs, defaultInboxLivenessDeps, isInboxLive, ORPHAN_INBOX_STALE_MS, } from './gc-orphan-inboxes.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { computeOpenCodePort, connectOpenCodeDrone, createOpenCodeLaunchKickoff, injectInitialKickoff } from './opencode-drone.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { BorgServerError, LegacySessionCredentialCollisionError } from './server-errors.js';
import { createHash } from 'node:crypto';
import { buildOpenCodeLaunchArgs } from './cli-tool-approval.js';
import { resolveWorkingRepo } from './working-repo.js';
const PRIVATE_STATE_UNAVAILABLE_COPY = [
    'Borg could not safely prepare its private local state.',
    'No Borg server or cube change was made.',
    "Before retrying, verify that Borg-owned directories are real, owned by your account, and not writable by other users. Verify that their parent directories are real, trusted directories owned by your account or the system and not writable by other users. Verify that Borg files are private regular files owned by your account, then run the same command again.",
].join('\n');
function affirmative(answer) {
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
}
function isLocalCubePresentationName(name) {
    return name.length >= 1 && name.length <= 120 &&
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name);
}
async function selectAssimilationAuthority(flags, deps) {
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
    if (!deps.isTTY() || flags.yes) {
        if (deps.defaultAuthority)
            return deps.defaultAuthority;
        deps.stderr('No local server selected. Use `borg assimilate --host <host> --here` to select a local server.\n');
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
    if (detected) {
        const answer = await deps.prompt(`Local Borg server detected at ${detected}.\nConnect this project to it? [Y/n]: `);
        if (affirmative(answer))
            return { kind: 'server', apiUrl: detected };
    }
    const host = await deps.prompt('Borg server host or URL: ');
    try {
        return { kind: 'server', apiUrl: normalizeServerEndpoint(host) };
    }
    catch (error) {
        deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        return null;
    }
}
function localAssimilateCommand(apiUrl, enroll = false) {
    return `\`borg assimilate --host ${apiUrl}${enroll ? ' --enroll' : ''}\``;
}
function localAssimilateRoleCommand(apiUrl) {
    return `\`borg assimilate --host ${apiUrl} <role>\``;
}
function localAssimilateCliCommand(apiUrl, cli) {
    return `\`borg assimilate --host ${apiUrl} --cli ${cli}\``;
}
function reportServerFailure(deps, apiUrl, error, enroll = false) {
    const message = error instanceof Error ? error.message : String(error);
    const retryCommand = localAssimilateCommand(apiUrl, enroll);
    if (error instanceof BorgServerError && error.code === 'CREATE_CUBE_DENIED') {
        deps.stderr(`This enrolled client cannot create a cube on ${apiUrl}. ` +
            'Ask the server operator to grant access to a cube, then rerun ' +
            `${localAssimilateCommand(apiUrl)}.\n`);
        return 1;
    }
    if (error instanceof BorgServerError && error.code === 'NOT_ENROLLED') {
        deps.stderr(`No saved enrollment for ${apiUrl}. Run ` +
            `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`);
        return 1;
    }
    if (error instanceof BorgServerError && error.code === 'CREDENTIAL_REJECTED') {
        deps.stderr(`The saved enrollment for ${apiUrl} was rejected. Re-run ` +
            `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`);
        return 1;
    }
    if (error instanceof LegacySessionCredentialCollisionError) {
        deps.stderr(`Local session credential collision detected.\n` +
            `No local credentials were changed.\n` +
            `Next: run borg assimilate --host ${error.origin} --enroll.\n`);
        return 1;
    }
    // A pin-matched typed 401: the server verified its own identity but rejected
    // THIS worktree's session bearer with an explicit terminal outcome.
    // Distinct from a protocol/version mismatch and from a rejected enrollment:
    // only this worktree's saved local seat is affected, and recovery is scoped to
    // this worktree — no server/trust-anchor/cube/other-worktree reset, no restart
    // or version-alignment advice (#1082).
    if (error instanceof BorgServerError && error.code === 'SESSION_REVOKED') {
        return diagnoseSessionTermination(deps, apiUrl, 'revoked');
    }
    if (error instanceof BorgServerError && error.code === 'SESSION_REJECTED') {
        return diagnoseSessionTermination(deps, apiUrl, 'superseded');
    }
    if (error instanceof BorgServerError && error.code === 'INVITATION_REJECTED') {
        deps.stderr(`The enrollment invitation for ${apiUrl} was rejected or expired. ` +
            'Ask the server operator for a replacement invitation — the server can stay running: ' +
            'for an unclaimed owner client run `borg-mcp-server owner-invite`; for an ordinary ' +
            'client run `borg-mcp-server client-invite`. Then rerun ' +
            `${localAssimilateCommand(apiUrl, true)}.\n`);
        return 1;
    }
    if (/HTTP 40[13]|auth(?:entication|orization)|credential.*(?:invalid|rejected)/i.test(message)) {
        deps.stderr(`The saved enrollment for ${apiUrl} was rejected. Re-run ` +
            `${localAssimilateCommand(apiUrl, true)} from the operator’s terminal.\n`);
        return 1;
    }
    if (/seat store lock file .* is stale/i.test(message)) {
        // RULED option (b): a lock whose recorded holder is DEAD (or whose payload is
        // corrupt) is NEVER auto-removed. Surface the fail-closed guidance verbatim —
        // it already names the exact lockfile path and the delete-only-if-no-borg
        // instruction — so the operator can clear it by hand, then retry.
        deps.stderr(`${safeStderr(message)}\nAfter confirming no borg process is running and clearing the ` +
            `stale lock, rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/(?:seat|credential) store is busy/i.test(message)) {
        deps.stderr(`Borg's local seat store is busy for ${apiUrl} because another Borg process is ` +
            `creating or resuming saved seat state. Wait for it to finish, then rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/(?:local )?seat store|(?:secure )?credential (?:store|storage)/i.test(message)) {
        deps.stderr(`Borg could not access its local seat store for ${apiUrl}. ` +
            `Ensure its directory on this machine is readable and writable, then rerun ${retryCommand}.\n`);
        return 1;
    }
    if (/trust|certificate|\bCA\b|authority state|pinned identity|cross-authority/i.test(message)) {
        deps.stderr(`Borg could not verify the expected server identity for ${apiUrl}. ` +
            'Verify that this is the expected server. If it was re-initialized, stop it, ' +
            'run `borg-mcp-server start`, then rerun ' +
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
    return `\`borg reset-local-seat --host ${apiUrl}\``;
}
// Pin-matched terminal session diagnosis. This is intentionally output-only:
// only the explicit offline reset command may clear the saved local seat.
function diagnoseSessionTermination(deps, apiUrl, outcome) {
    const message = outcome === 'revoked'
        ? 'Local session was revoked.'
        : 'Local session was superseded by a newer enrollment.';
    deps.stderr(`${message}\n` +
        `Next: run borg reset-local-seat, then borg assimilate --host ${apiUrl} --enroll.\n`);
    return 1;
}
export async function runAssimilate(args, deps) {
    // ----- Input validation (before any subprocess work) -----
    if (args.role !== undefined) {
        const v = validateName(args.role);
        if (!v.ok) {
            deps.stderr(v.error + '\n');
            return 1;
        }
    }
    if (args.flags.worktree !== undefined) {
        const v = validateName(args.flags.worktree);
        if (!v.ok) {
            deps.stderr(v.error + '\n');
            return 1;
        }
    }
    try {
        await deps.preparePrivateRoot();
    }
    catch {
        deps.stderr(`${PRIVATE_STATE_UNAVAILABLE_COPY}\n`);
        return 1;
    }
    // Read local seat state before authority discovery, which may probe the local
    // server. A retired replacement collision must not send either saved bearer or
    // perform any other network request.
    let existing = null;
    let hasPersistedIdentity = false;
    let localSeatReadError;
    try {
        existing = await deps.getActiveCube();
        hasPersistedIdentity = existing !== null || await deps.hasPersistedActiveCube();
    }
    catch (error) {
        if (error instanceof LegacySessionCredentialCollisionError) {
            return reportServerFailure(deps, error.origin, error);
        }
        localSeatReadError = error;
    }
    // ----- Step 1: Select and authenticate the local server -----
    const authority = await selectAssimilationAuthority(args.flags, deps);
    if (!authority)
        return 1;
    if (localSeatReadError !== undefined) {
        return reportServerFailure(deps, authority.apiUrl, localSeatReadError);
    }
    // ----- Repository + cube-name preflight -----
    // Resolve and, where necessary, confirm local presentation data before an
    // owner invitation can be consumed. A declined/underivable basename must
    // not leave a successfully enrolled client behind.
    const projectRoot = deps.findProjectRoot(deps.cwd());
    let cubeName;
    if (args.flags.cubeName) {
        cubeName = args.flags.cubeName;
    }
    else {
        const remoteResult = deps.runSync('git', ['remote', 'get-url', 'origin'], projectRoot);
        const remoteUrl = remoteResult.status === 0 ? remoteResult.stdout : null;
        const sanitizedRemote = remoteUrl ? sanitizeRemoteUrl(remoteUrl) : null;
        const parsedRepo = sanitizedRemote ? parseGitRemote(sanitizedRemote) : null;
        if (!parsedRepo) {
            const bareResult = deps.runSync('git', ['rev-parse', '--is-bare-repository'], projectRoot);
            if (bareResult.status === 0 && bareResult.stdout.trim() === 'true') {
                deps.stderr('borg assimilate requires a non-bare repository worktree. ' +
                    (authority.kind === 'server'
                        ? `Clone or check out the repository, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`
                        : 'Clone or check out the repository, then retry.\n'));
                return 1;
            }
        }
        cubeName = deriveCubeName(projectRoot, remoteUrl);
        if (!cubeName) {
            deps.stderr('Could not derive a cube name from this repository. ' +
                (authority.kind === 'server'
                    ? `Rerun ${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`
                    : 'Pass --cube-name <name> and retry.\n'));
            return 1;
        }
        if (!parsedRepo) {
            if (sanitizedRemote) {
                deps.stderr(`Could not parse the origin remote; using directory name '${cubeName}' as the cube name.\n`);
            }
            if (!args.flags.yes) {
                if (!deps.isTTY()) {
                    deps.stderr(`Using directory name '${cubeName}' as the cube name requires confirmation. ` +
                        (authority.kind === 'server'
                            ? `Rerun ${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\` or \`--yes\`.\n`
                            : 'Re-run with --cube-name <name> or --yes.\n'));
                    return 1;
                }
                const confirmed = await deps.prompt(`No usable origin remote was found. Use directory name '${cubeName}' as the cube name? [Y/n]: `);
                if (!affirmative(confirmed)) {
                    deps.stderr(authority.kind === 'server'
                        ? `Cube creation for ${authority.apiUrl} was cancelled. Rerun ` +
                            `${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`
                        : 'Cube creation cancelled. Re-run with --cube-name <name> to choose a name.\n');
                    return 1;
                }
            }
        }
    }
    if (authority.kind === 'server' && !isLocalCubePresentationName(cubeName)) {
        deps.stderr(`Invalid cube name for ${authority.apiUrl}. Use 1–120 letters, digits, spaces, dots, ` +
            'underscores, or hyphens, starting with a letter or digit. Rerun ' +
            `${localAssimilateCommand(authority.apiUrl)} with \`--cube-name <name>\`.\n`);
        return 1;
    }
    let auth;
    {
        try {
            let serverAuth;
            if (args.flags.enroll) {
                if (!deps.isTTY()) {
                    deps.stderr('Local enrollment requires an interactive operator terminal. ' +
                        `Re-run ${localAssimilateCommand(authority.apiUrl, true)} from the operator’s terminal.\n`);
                    return 1;
                }
                const resumed = await deps.resumeServerEnrollment(authority.apiUrl, () => {
                    deps.stderr(`Resuming the pending enrollment for \`${authority.apiUrl}\`; ` +
                        'do not enter another invitation.\n');
                });
                if (resumed) {
                    serverAuth = resumed;
                }
                else {
                    let invitation = await deps.promptSecret(`Enrollment invitation for \`${authority.apiUrl}\` (single-use; hidden input):`);
                    if (!invitation) {
                        deps.stderr(`No enrollment invitation was entered for ${authority.apiUrl}. ` +
                            `Ask the server operator for one, then rerun ${localAssimilateCommand(authority.apiUrl, true)}.\n`);
                        return 1;
                    }
                    try {
                        serverAuth = await deps.connectServer(authority.apiUrl, { invitation });
                    }
                    finally {
                        // Strings cannot be zeroized in JavaScript, but drop this command's
                        // reference immediately after the exchange instead of retaining the
                        // invitation through the rest of assimilation/agent launch.
                        invitation = '';
                    }
                }
                if (serverAuth.serverCapabilities?.includes('create_cube')) {
                    deps.stderr(`Owner client enrolled with \`${authority.apiUrl}\`. ` +
                        'Creating or joining this repository’s cube next.\n');
                }
                else {
                    deps.stderr(`Ordinary client enrolled with \`${authority.apiUrl}\`. ` +
                        'Checking for an accessible repository cube next.\n');
                }
            }
            else {
                serverAuth = await deps.connectServer(authority.apiUrl);
            }
            auth = {
                token: serverAuth.token,
                apiUrl: authority.apiUrl,
                serverTrustIdentity: serverAuth.trustIdentity,
            };
        }
        catch (error) {
            return reportServerFailure(deps, authority.apiUrl, error, args.flags.enroll === true);
        }
    }
    // ----- Sprint 19 (gh#184): Reorder for strict-rollback semantics. -----
    // The previous flow created a sibling worktree (FS state) BEFORE
    // role resolution + API assimilate. Any early-return between
    // worktree-spawn and API success orphaned the worktree (gh#184
    // canonical case: unknown role arg). The new flow defers all FS
    // state until AFTER the API assimilate succeeds — early-return at
    // role resolution / listCubes / createCube / template-prompt /
    // template-invalid-choice is now structurally clean (no orphan
    // class possible). Worktree rollback narrows to the single
    // setActiveCube failure path post-worktree-creation.
    // Sprint 18: capture pre-chdir cwd for the post-exit shell-cd hint
    // (no chdir has happened yet; this is a stable starting point).
    const originalCwd = deps.cwd();
    // ----- Step 3: Cube existence check (with auto-refresh on auth failure) -----
    // gh#653 B4: announce each network step. These calls take 2–5s and were
    // previously silent, so a user read the wait as a hang and Ctrl-C'd mid-run.
    deps.stderr('Checking your cubes…\n');
    let allCubes;
    try {
        allCubes = await deps.listCubes(auth.apiUrl, auth.token, auth.serverTrustIdentity);
    }
    catch (err) {
        return reportServerFailure(deps, authority.apiUrl, err);
    }
    const existingCube = allCubes.find((c) => c.name === cubeName);
    // ----- Step 4: Fetch detail OR create cube -----
    let cubeDetail;
    let isFirstDrone;
    if (existingCube) {
        try {
            cubeDetail = await deps.getCube(auth.apiUrl, auth.token, existingCube.id, auth.serverTrustIdentity);
        }
        catch (error) {
            return reportServerFailure(deps, authority.apiUrl, error);
        }
        isFirstDrone = (cubeDetail.drones?.length ?? 0) === 0;
    }
    else {
        // ----- Step 4a: First-drone bootstrap (template selection) -----
        let chosenTemplate;
        if (args.flags.noTemplate ||
            (args.flags.template !== undefined && args.flags.template !== 'default')) {
            deps.stderr(`Borg server ${authority.apiUrl} supports its default cube template only. ` +
                `Rerun ${localAssimilateCommand(authority.apiUrl)} without \`--template\` or \`--no-template\`.\n`);
            return 1;
        }
        chosenTemplate = 'default';
        // gh#653 B4: progress for the create round-trip (silent-window stall).
        deps.stderr(cubeName ? `Creating cube '${cubeName}'…\n` : 'Creating your cube…\n');
        try {
            const createParams = chosenTemplate
                ? {
                    name: cubeName ?? undefined,
                    template: chosenTemplate,
                    projectRoot,
                }
                : { name: cubeName ?? undefined };
            cubeDetail = await deps.createCube(auth.apiUrl, auth.token, createParams, auth.serverTrustIdentity);
        }
        catch (error) {
            return reportServerFailure(deps, authority.apiUrl, error);
        }
        isFirstDrone = true;
    }
    // Read the worktree identity before role selection. A live local seat must
    // retain its original role so the attach request reuses the exact durable
    // retry binding instead of selecting another unoccupied role and minting a
    // duplicate seat.
    const wantSibling = args.flags.worktree !== undefined || (existing !== null && !args.flags.here);
    // `let`: the bound-pending resume path (CR#2) OVERRIDES this from the stored
    // operation so a rerun re-derives the EXACT original sibling seat ref.
    let sessionOperation = {
        // Capture the source repository before a successful sibling attach changes
        // cwd. This is the stable seat/sibling namespace for the pending bearer, so a
        // deliberate sibling never collides with the durable in-place seat's bearer.
        projectRoot,
        kind: wantSibling ? 'sibling' : 'seat',
        // CR1(a): an implicit sibling's operation key must be COLLISION-SAFE — two
        // unnamed siblings of the same (origin,trust,cube,role) must get DISTINCT seat
        // refs, else prepareSeat reuses the first sibling's ACTIVE record and the
        // activate+bind step overwrites its worktree (an active seat silently unseated
        // and rebound). A named sibling already keys on its name; an unnamed one derives
        // a per-invocation-unique key so every distinct implicit sibling target mints a
        // distinct bearer / seat ref.
        operationKey: wantSibling
            ? (args.flags.worktree === undefined
                ? `implicit-sibling:${randomUUID()}`
                : `named-sibling:${args.flags.worktree}`)
            : 'current-worktree',
    };
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
                deps.stderr(`This worktree has saved seat metadata for ${authority.apiUrl}, but its local session ` +
                    'credential could not be loaded from the local seat store. No new seat was created. Run ' +
                    `${resetLocalSeatCommand(authority.apiUrl)} to clear this worktree's saved seat, then ` +
                    `ask the operator for a new invitation and rerun ${localAssimilateCommand(authority.apiUrl, true)}.\n`);
                return 1;
            }
        }
        if (existing && args.flags.here &&
            (existing.apiUrl !== auth.apiUrl ||
                existing.serverTrustIdentity !== auth.serverTrustIdentity)) {
            deps.stderr(`This worktree's saved seat does not match ${authority.apiUrl}. ` +
                'No new seat was created. Restore the expected server identity or use a fresh ' +
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
            const status = await deps.probeSeat(existing.sessionToken ?? '', auth.apiUrl, auth.serverTrustIdentity);
            // Canonical rotated/revoked path: a pin-matched 401 on THIS worktree's
            // saved bearer. PURE DIAGNOSIS — attach never mutates local state on a
            // rejection; it points at the offline `borg reset-local-seat` command.
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
                deps.stderr(`The saved enrollment for ${authority.apiUrl} was rejected. No new seat was created ` +
                    `and nothing was changed. Re-enroll with ${localAssimilateCommand(authority.apiUrl, true)} ` +
                    'from the operator’s terminal.\n');
                return 1;
            }
            if (status === 'trust-mismatch') {
                // Terminal: the pinned identity changed. Restarting the server does NOT
                // fix it — verify this is the expected server / re-initialization.
                deps.stderr(`Borg could not verify the expected server identity for ${authority.apiUrl}. ` +
                    'No new seat was created. Verify that this is the expected server; if it was ' +
                    're-initialized, restore the expected identity, then rerun ' +
                    `${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'endpoint-mismatch') {
                // CR5: a verified server returned 404 for the drone endpoint — a protocol /
                // client-server VERSION mismatch, not a transient blip. Restarting does not
                // fix it; align versions. Non-destructive: no seat created, nothing reset.
                deps.stderr(`Borg reached ${authority.apiUrl} but it did not recognize this worktree's drone ` +
                    'endpoint — the client and server versions are likely incompatible. No new seat ' +
                    'was created and nothing was changed. Update the Borg client and/or server so ' +
                    `their versions match, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'server-failure') {
                // CR5: a verified server returned 5xx — its own internal error. Transient:
                // check the server, then retry. Non-destructive.
                deps.stderr(`Borg reached ${authority.apiUrl} but it returned a server error while verifying ` +
                    "this worktree's saved seat. No new seat was created. Check the server (its logs / " +
                    `\`borg-mcp-server start\`), then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'unreachable' || status === 'indeterminate') {
                // CR5: transport failure / timeout (unreachable) or a genuinely ambiguous
                // failure (indeterminate) — both transient. Start or restart the server.
                deps.stderr(`Borg could not verify this worktree's saved seat on ${authority.apiUrl}. ` +
                    'No new seat was created. Start or restart the server with ' +
                    `\`borg-mcp-server start\`, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            if (status === 'live' && !savedLocalRole) {
                deps.stderr(`Borg verified this worktree's saved seat on ${authority.apiUrl}, but its saved ` +
                    'role is unavailable. No new seat was created. Ask the server operator to restore ' +
                    `the role, then rerun ${localAssimilateCommand(authority.apiUrl)}.\n`);
                return 1;
            }
            reattachPriorId = existing.droneId;
            remintInvalidPrior = status === 'evicted';
        }
    }
    else if (existing && args.flags.here) {
        if (existing.serverTrustIdentity !== undefined || existing.apiUrl !== auth.apiUrl) {
            deps.stderr('This worktree\'s saved seat belongs to a different Borg authority. ' +
                'No new seat was created; use a fresh worktree.\n');
            return 1;
        }
        reattachPriorId = existing.droneId;
    }
    // ----- Step 5: Role resolution -----
    let resolvedRole;
    if (savedLocalRole) {
        resolvedRole = savedLocalRole;
    }
    else if (args.role !== undefined) {
        resolvedRole = matchRoleByName(cubeDetail.roles, args.role);
        if (!resolvedRole) {
            // Sprint 19 (gh#184) + drone-7 metaphor argument: include a
            // fuzzy-match "did you mean ...?" suggestion to serve Queen's
            // "more user-friendly" intent without violating the
            // Borg-collective metaphor (collective defines roles; drones
            // slot in). Levenshtein distance ≤2 on the cube's role names.
            const available = cubeDetail.roles.map((r) => r.name).join(', ');
            const suggestion = suggestRoleName(args.role, cubeDetail.roles.map((r) => r.name));
            const suggestionLine = suggestion ? ` Did you mean "${suggestion}"?` : '';
            if (authority.kind === 'server') {
                deps.stderr(`No role matching "${args.role}" in cube "${cubeDetail.name}" on ${authority.apiUrl}. ` +
                    `Available: ${available}.${suggestionLine}\n` +
                    `Rerun ${localAssimilateRoleCommand(authority.apiUrl)} with one of the available roles.\n`);
            }
            else {
                deps.stderr(`no role matching "${args.role}" in cube "${cubeDetail.name}". Available: ${available}.${suggestionLine}\n` +
                    `(Use --template <name> on first-drone setup or run \`borg_create-role\` from inside Claude.)\n`);
            }
            return 1;
        }
    }
    else {
        const occupiedRoleIds = occupiedRoleIdsForAutoRole(cubeDetail.drones ?? []);
        resolvedRole = pickDefaultRole(cubeDetail.roles, { isFirstDrone, occupiedRoleIds });
        if (!resolvedRole) {
            if (authority.kind === 'server') {
                deps.stderr(`Cube "${cubeDetail.name}" on ${authority.apiUrl} has no default or human-seat role. ` +
                    `Ask the server operator to configure a role, then rerun ` +
                    `${localAssimilateRoleCommand(authority.apiUrl)}.\n`);
            }
            else {
                deps.stderr(`cube "${cubeDetail.name}" has no default or human-seat role; cannot infer a role. ` +
                    `Either pass a role argument explicitly (e.g. \`borg assimilate builder\`) or ` +
                    `run \`borg_create-role\` from inside Claude to set up roles.\n`);
            }
            return 1;
        }
    }
    // ----- Step 5b: --here collision check BEFORE the API mint (gh#780) -----
    // Pre-gh#780 this check lived in Step 7 — AFTER the API assimilate — so a
    // `--here` run in a directory that already hosts a drone minted a fresh
    // drones row server-side, then aborted before Step 8 ever persisted the
    // mapping: an orphan seat with no local identity. The check must precede
    // the mint. (The full worktree DECISION stays in Step 7 by design — FS
    // state only after API success; this hoists only the abort case.)
    //
    // PR-D refinement: --here + existing + SAME authority/cube is the
    // saved-seat recovery flow. The local
    // seats first prove liveness with their keychained session, then reuse the
    // saved role/retry binding; only authoritative eviction rotates that retry.
    // Role defaults and local launch state do not select the model. The explicit
    // Claude-only flag remains temporarily for compatibility with existing
    // invocations.
    const effectiveModel = args.flags.model ?? null;
    // Resolve the agent CLI now so the worker learns agent_kind AT assimilate
    // time.
    const cli = await deps.resolveCli(args.flags.cli);
    try {
        ensureCliMcpConfigured(cli);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (authority.kind === 'server') {
            deps.stderr(`${cli} MCP configuration failed for ${authority.apiUrl}: ${safeStderr(message)}. ` +
                `Fix the ${cli} MCP configuration, then rerun ` +
                `${localAssimilateCliCommand(authority.apiUrl, cli)}.\n`);
        }
        else {
            deps.stderr(`${cli} MCP configuration failed: ${message}\n`);
        }
        return 1;
    }
    // The TYPED prepare-time expectation (ratified clause 3 / CR #1). Declared HERE,
    // BEFORE the mint+send, and revalidated at BOTH the cube-lock-held PREPARE (so a
    // reset that wins before PREPARE aborts before any credential is created/sent)
    // and FINALIZE. resume/reattach/remint pin the FULL prior binding (ref + drone
    // id [+ live digest]); fresh/sibling declare ABSENT.
    let sessionExpected;
    if (resumeCredentialRef && resumeState === 'pending') {
        // CR#2: a bound-PENDING resume (a sibling whose activation failed) re-sends the
        // identical pending bearer the server already digest-bound. A PENDING record is
        // NOT a live binding, so it declares ABSENT (pending-reuse): prepareSeat REUSES
        // the existing pending record (identical bearer). An EXACT expectation would be
        // rejected by prepareSeat's `prior.state==='active'` guard and abort the only
        // ghost-free recovery.
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
    // CR1(b): PREPARE-time revalidation is preserved for siblings too. A sibling
    // declares an ABSENT expectation: a PENDING record at the ref (a lost-response
    // retry / crash-in-gap) stays reusable so the identical bearer is re-sent, but an
    // ACTIVE record holding the ref is a mismatch → abort (never silently reuse/move
    // a live binding). With the collision-safe sibling key above the fresh ref is
    // normally empty, so ABSENT passes and the mint proceeds; the check is the
    // defense that stops an active seat from being unseated.
    const revalidateAtPrepare = true;
    // ----- Step 6: API assimilate (no FS state yet — clean exit on failure) -----
    // gh#653 B4: progress for the seat-mint round-trip (silent-window stall).
    deps.stderr(`Joining cube '${cubeDetail.name}' as ${resolvedRole.name}…\n`);
    let result;
    try {
        const assimilateParams = {
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
            revalidate_at_prepare: revalidateAtPrepare,
        };
        result = await deps.assimilate(auth.apiUrl, auth.token, assimilateParams, auth.serverTrustIdentity);
    }
    catch (err) {
        // gh#877 follow-up: a re-attach (`--here`) whose saved seat was evicted is
        // REFUSED server-side (410 DRONE_EVICTED) rather than silently re-minting a
        // fresh drone. Surface the terminal recovery path instead of the generic
        // "assimilate failed". Only on a reattach attempt (reattachPriorId set);
        // a non-reattach DroneEvictedError falls through to the generic message.
        if (err instanceof DroneEvictedError && reattachPriorId != null) {
            deps.stderr(`This worktree's saved seat on ${authority.apiUrl} was evicted. ` +
                `Remove this worktree, or from a fresh worktree run ` +
                `${localAssimilateCommand(authority.apiUrl)}.\n`);
            return 1;
        }
        // Pin-matched terminal session outcomes are pure diagnosis.
        // Reached only after a successful pinned-TLS attach, so it is pin-matched by
        // construction — a pin mismatch throws a distinct trust error and never
        // enters this branch. Attach mutates NOTHING; it recommends the offline
        // `borg reset-local-seat` command.
        if (err instanceof BorgServerError && reattachPriorId != null) {
            if (err.code === 'SESSION_REVOKED') {
                return diagnoseSessionTermination(deps, authority.apiUrl, 'revoked');
            }
            if (err.code === 'SESSION_REJECTED') {
                return diagnoseSessionTermination(deps, authority.apiUrl, 'superseded');
            }
        }
        if (authority.kind === 'server') {
            return reportServerFailure(deps, authority.apiUrl, err);
        }
        const message = err instanceof Error ? err.message : String(err);
        deps.stderr(`assimilate failed: ${message}\n`);
        return 1;
    }
    if (authority.kind === 'server' && result.prepareAborted) {
        // CR #1: the cube-lock-held PREPARE revalidation aborted BEFORE any credential
        // was minted or sent — this worktree's saved seat changed under us (a
        // concurrent offline reset, or a competing enroll). No FS/network mutation
        // happened; never silently recreate.
        deps.stderr(`This worktree's saved local seat on ${authority.apiUrl} changed before the attach ` +
            '(a concurrent reset or enroll); no credential was created or sent and nothing was ' +
            `changed. Re-run ${localAssimilateCommand(authority.apiUrl)} to attach against the ` +
            'current state.\n');
        return 1;
    }
    if (authority.kind === 'server' && result.local_session === undefined) {
        return reportServerFailure(deps, authority.apiUrl, new Error('Borg server did not return compatible secure session metadata'));
    }
    // The server may assimilate a member into a DIFFERENT role than the client's
    // auto-picked default (gh#700 fallback: when the member's invite doesn't
    // grant the default role, the server picks one of their GRANTED roles).
    // Resolve the role the SERVER ACTUALLY assigned (result.role_id) and use it
    // for all human-facing display + naming below — not the client's pre-pick.
    // The drone label / session token are already server-truth; this aligns the
    // displayed role name + worktree slug with what was actually assigned.
    const assignedRole = cubeDetail.roles.find((r) => r.id === result.role_id) ?? resolvedRole;
    if (result.result === 'reused') {
        // The seat's existing role is authoritative on an idempotent reattach —
        // a role difference is expected, not a grant fallback. The bearer is
        // reused, not rotated: no new drone minted.
        deps.stderr(`re-attached to existing seat ${result.drone_label} (same session, no new drone minted)\n`);
    }
    else if (assignedRole.id !== resolvedRole.id) {
        deps.stderr(`The requested role "${resolvedRole.name}" was unavailable; ` +
            `attached to the "${assignedRole.name}" seat instead.\n`);
    }
    // ----- Step 7: Worktree decision (FS state ONLY after API success) -----
    // (`existing` was read at Step 5b; a different-cube --here collision
    // already aborted there, pre-mint. The surviving --here + existing case
    // is the SAME-cube reattach — an in-place recovery, never a sibling
    // spawn.)
    let spawnedWorktreePath = null;
    if (wantSibling) {
        // BUG-4 / gh#150 fix (v0.9.5): `git worktree add --detach <path>`
        // fails with "fatal: not a valid object name: 'HEAD'" when the
        // repo has no commits yet (unborn HEAD). Detect explicitly via
        // `git rev-parse --verify HEAD` so we surface an actionable
        // prerequisite error rather than git's cryptic internal message.
        const headProbe = deps.runSync('git', ['rev-parse', '--verify', 'HEAD'], projectRoot);
        if (headProbe.status !== 0) {
            deps.stderr(`sibling worktree spawn requires HEAD pointing at a commit.\n` +
                `  Fix: create at least one commit (\`git commit --allow-empty -m "initial"\`)\n` +
                `  OR:  pass --here to skip the sibling spawn and use the current directory\n`);
            return 1;
        }
        const localHead = headProbe.stdout.trim();
        const originProbe = deps.runSync('git', ['remote', 'get-url', 'origin'], projectRoot);
        let startRef = 'HEAD';
        if (originProbe.status === 0 && originProbe.stdout.trim().length > 0) {
            // gh#238: when origin exists, fetch it so the new worktree starts on the
            // latest remote default branch rather than a possibly stale local HEAD.
            deps.runSync('git', ['fetch', 'origin'], projectRoot);
            const mainProbe = deps.runSync('git', ['rev-parse', '--verify', 'origin/main'], projectRoot);
            if (mainProbe.status === 0) {
                startRef = 'origin/main';
            }
            else {
                const masterProbe = deps.runSync('git', ['rev-parse', '--verify', 'origin/master'], projectRoot);
                if (masterProbe.status === 0) {
                    startRef = 'origin/master';
                }
            }
        }
        if (startRef === 'HEAD') {
            deps.stderr(`note: no usable origin; new worktree will start on local HEAD (${localHead.slice(0, 7)})\n`);
        }
        else {
            // Warn if local HEAD diverges from the remote default branch.
            const remoteHead = deps.runSync('git', ['rev-parse', startRef], projectRoot).stdout.trim();
            if (localHead !== remoteHead) {
                deps.stderr(`note: local HEAD (${localHead.slice(0, 7)}) differs from ${startRef} (${remoteHead.slice(0, 7)}); ` +
                    `new worktree will start on ${startRef}\n`);
            }
        }
        const repoBase = basename(projectRoot);
        const suffix = args.flags.worktree ?? roleSlug(assignedRole.name);
        // gh#556 Part 1: empty-suffix guard (CR-binding). roleSlug can yield '' for a
        // pathological all-special-char role name; an empty leaf would let join() collapse
        // the worktree path up to the repo-level dir (~/.borg/worktrees/<repo>) and spawn a
        // worktree at the parent-of-all-this-repo's-worktrees. Fail loud BEFORE the path calc.
        if (suffix.length === 0) {
            deps.stderr(`cannot derive a worktree name from role "${assignedRole.name}"; ` +
                `pass an explicit --worktree <name>\n`);
            return 1;
        }
        // gh#556 Part 1: NEW worktrees live under ~/.borg/worktrees/<repo>/<name>
        // (was a sibling <parent>/<repo>-<name>). Existing siblings are untouched
        // (absolute git-registered paths). Collision dedup KEPT (<name>-<n>).
        const homeDir = deps.homedir();
        let candidate = computeWorktreePath(homeDir, repoBase, suffix);
        let wtBranch = perWorktreeBranchName(basename(candidate), repoBase);
        let n = 2;
        // gh#864: dedup against an existing worktree PATH/registration AND against a
        // lingering UNMERGED per-worktree branch. `git worktree add -b <wtBranch>`
        // (below) hard-fails when <wtBranch> already exists even if its old worktree
        // was pruned — so a stale ref would block the spawn. A MERGED lingering
        // branch is safely adoptable (handled at the add), so it does NOT force a
        // suffix bump; only an UNMERGED ref (carrying un-merged commits) bumps to a
        // fresh suffix so we never reuse/clobber its work.
        while (deps.pathExists(candidate) ||
            worktreeRegistered(deps, projectRoot, candidate) ||
            (localBranchExists(deps.runSync, projectRoot, wtBranch) &&
                !isMerged(deps.runSync, projectRoot, wtBranch, startRef))) {
            candidate = computeWorktreePath(homeDir, repoBase, suffix, n);
            wtBranch = perWorktreeBranchName(basename(candidate), repoBase);
            n++;
        }
        // gh#556 Part 1: create the intermediate ~/.borg/worktrees/<repo>/ before
        // `git worktree add` (git creates the leaf, not the parent chain). Plain
        // recursive mkdir — NO chmod of the existing ~/.borg (credentials file).
        deps.mkdirp(dirname(candidate));
        // gh#33 (Q1/Q4): spawn on a named per-worktree branch (wt-<suffix>),
        // NOT detached HEAD. The named branch is current with startRef and is
        // where the drone's feature branches get cut from. Uniform for every
        // role incl. coordinator — main is never a working branch (Q4).
        // Branch naming is UNAFFECTED by the relocation: perWorktreeBranchName's
        // as-is else-branch maps the new basename <suffix> → wt-<suffix> (== old).
        //
        // gh#864: if <wtBranch> already exists here it is MERGED (the loop bumped
        // past any unmerged ref), so ADOPT it — `git worktree add <path> <branch>`
        // (no -b) attaches the merged branch instead of failing on a create-
        // collision. A fresh suffix has no ref → create it at startRef with -b.
        const wt = localBranchExists(deps.runSync, projectRoot, wtBranch)
            ? deps.runSync('git', ['worktree', 'add', candidate, wtBranch], projectRoot)
            : deps.runSync('git', ['worktree', 'add', '-b', wtBranch, candidate, startRef], projectRoot);
        if (wt.status !== 0) {
            deps.stderr(`git worktree add failed: ${safeStderr(wt.stderr)}\n`);
            return 1;
        }
        deps.stderr(`spawned sibling worktree at ${candidate} on branch ${wtBranch} (${startRef}); ` +
            `the original dir keeps its active seat — run \`borg reset-local-seat\` there if that binding is stale.\n`);
        deps.chdir(candidate);
        deps.stderr(renderWorktreeSteeringNote(candidate, wtBranch, projectRoot));
        spawnedWorktreePath = deps.cwd();
    }
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
    // Local-server authority: drive the COMPOSITE cube-owned FINALIZE (Race 2).
    // The cube lock is held OUTER across revalidate → binding-write → activate; the
    // typed expectation is declared HERE at the orchestration layer (reattach =
    // EXACT prior binding with its live-bearer digest; eviction remint = EXACT ref
    // only, bearer intentionally replaced; fresh/sibling = ABSENT).
    if (result.finalize === undefined || deps.finalizeServerSeat === undefined) {
        deps.stderr('Local Borg server session metadata is incomplete; no seat was saved.\n');
        rollbackWorktree();
        return 1;
    }
    {
        // The SAME typed expectation declared before PREPARE is revalidated again at
        // FINALIZE (commit-time revalidation, ratified clause 3).
        let outcome;
        try {
            outcome = await deps.finalizeServerSeat({
                active: activeCube,
                expected: sessionExpected,
                activate: result.finalize.activate,
                scrubPending: result.finalize.scrubPending,
            });
        }
        catch (err) {
            // A BINDING-WRITE (or revalidate) failure BEFORE the binding landed. Nothing
            // owns the spawned worktree yet, so rolling it back is safe.
            const message = err instanceof Error ? err.message : String(err);
            deps.stderr(`setActiveCube failed: ${message}\n`);
            rollbackWorktree();
            return 1;
        }
        if (!outcome.committed) {
            if (outcome.reason === 'activation-failed') {
                // CR #5: the atomic activate+bind did NOT commit (missing/replaced/threw), so
                // the record stays PENDING with no worktree of its own. CR#2/CR#4: bind that
                // exact pending record to THIS preserved worktree WITHOUT activating it — the
                // record stays pending (non-hydratable) but becomes DISCOVERABLE from here, so
                // a rerun FROM this worktree re-derives the exact original operation and
                // re-sends the identical bearer, converging on the SAME seat (no ghost).
                //
                // CR#4 (SR-seven false-success revocation): the bindPending OUTCOME is
                // load-bearing and must be BRANCHED. A blanket "safe to re-run / identical
                // seat reused" claim on a missing/replaced/thrown bind is a FALSE-SUCCESS
                // revocation failure — the worktree would NOT own a durable locator, yet the
                // operator would be told convergence is guaranteed. Preserve the spawned
                // worktree ONLY when it owns a durable locator (a `bound` outcome).
                let bindOutcome = 'unavailable';
                if (result.finalize?.bindPending) {
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
                    // The worktree now owns a durable locator (the bound-pending record points
                    // here). PRESERVE it. Truthful convergence copy: a rerun FROM here re-sends
                    // the identical bearer (no duplicate), and `reset-local-seat` from here now
                    // discovers + clears the bound-pending record.
                    deps.stderr(`This worktree's secure session on ${auth.apiUrl} did not finish activating, but ` +
                        'its resumable seat state was PRESERVED here. This worktree was NOT removed. From ' +
                        `here, re-run ${localAssimilateCommand(auth.apiUrl)} to converge (the identical seat ` +
                        `is reused — no duplicate is minted), or run ${resetLocalSeatCommand(auth.apiUrl)} to ` +
                        'clear it.\n');
                    return 1;
                }
                // missing / replaced / threw / unavailable: the worktree owns NO durable
                // locator, so make NO convergence claim. Roll back the just-spawned worktree
                // (preserve ONLY when it owns a durable locator) and point at the offline reset.
                deps.stderr(`This worktree's secure session on ${auth.apiUrl} did not finish activating, and its ` +
                    'seat state could NOT be preserved to this worktree (it was concurrently reset or ' +
                    'replaced, or the local seat store could not be written). No usable seat remains here. ' +
                    `Run ${resetLocalSeatCommand(auth.apiUrl)} to clear any saved seat, then re-run ` +
                    `${localAssimilateCommand(auth.apiUrl)} to attach against the current state.\n`);
                rollbackWorktree();
                return 1;
            }
            // 'expectation-mismatch': the binding was NEVER written (this worktree's
            // saved seat changed under us between PREPARE and FINALIZE — a concurrent
            // reset or enroll). The composite scrubbed only our own pending record — no
            // orphan ACTIVE credential — so a just-spawned worktree is safe to remove.
            deps.stderr(`This worktree's saved local seat on ${auth.apiUrl} changed during attach ` +
                '(a concurrent reset or enroll); no seat was created and nothing was overwritten. ' +
                `Re-run ${localAssimilateCommand(auth.apiUrl)} to attach against the current state.\n`);
            rollbackWorktree();
            return 1;
        }
    }
    // The worktree, not a reminted drone UUID, is the stable local seat identity
    // for monitor runtime state. Capture it once before the lazy GC and launch
    // paths so both use the exact same explicit root.
    const agentCwd = deps.cwd(); // post-chdir if step 3 spawned a worktree
    const seatWorktree = deps.findProjectRoot(agentCwd);
    const monitorStateRoot = monitorStateRootForWorktree(seatWorktree);
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
    // ----- Step 8: Launch selected agent CLI -----
    // Mirrors the kickoff invocation from claude.ts (no-args path): the agent
    // picks up the newly-persisted ActiveCube via the MCP stdio server on
    // startup. The kickoff prompt re-enters /loop borg_regen so the new
    // drone bootstraps into the cube cleanly. The monitor clause (CR-PE-F1)
    // arms the inbox tail so the new drone wakes on peer log entries in
    // real time — without this, drones miss real-time wake events during
    // the bootstrap window and only self-heal at the /loop heartbeat.
    deps.setTerminalTitle(result.drone_label, cubeDetail.name);
    // Pedagogical hint to stdout before Claude takes over the terminal.
    // Ink does not enter alt-screen-buffer (verified empirically via PTY
    // probe 2026-05-19), so lines printed here remain visible in the
    // user's terminal scrollback above Claude's interactive UI. Color is
    // gated on TTY + NO_COLOR/CI env-var conventions; the welcome shape
    // itself is cube-agnostic so non-default templates render identically.
    const useColor = deps.isTTY() && !process.env.NO_COLOR && !process.env.CI;
    deps.stdout(renderAssimilationWelcome(result.drone_label, assignedRole.name, cubeDetail.name, useColor, authority.kind === 'server' ? authority.apiUrl : undefined));
    // gh#673 P2 (WI-1): install the project-local SessionStart orientation
    // hook into the launch root — covers BOTH the freshly-spawned sibling
    // worktree (agentCwd = the new worktree post-chdir) and the in-place /
    // --here path. Best-effort: a hook-install failure must never block
    // the assimilate (the bare-`borg` launcher re-ensures it).
    try {
        deps.installProjectSessionHook(agentCwd);
    }
    catch {
        deps.stderr(`warning: could not install the project-local SessionStart hook in ${agentCwd}; it will be re-attempted on the next borg launch\n`);
    }
    // gh#33 (Q2/Q4/Q6): in-place wt- adoption. A freshly-spawned worktree is
    // already at origin/main on a fresh wt- branch, so only the in-place /
    // --here path (running in an existing checkout) needs handling. ADOPT
    // the per-worktree branch — switch the checkout onto wt-<suffix> at
    // origin/main when clean + merged. This both moves the drone off main
    // (Q4: main is never a working branch) AND brings the branch current,
    // which a bare ff-sync would not do (it would leave a main checkout on
    // main — the gap two-of-four-CR 27af1001 + QA c7a0c615 caught). Dirty ->
    // skip + surface; unmerged HEAD -> block + surface; NEVER discards.
    // Using adoptWorktree (HEAD-merged check + explicit `switch -C wtBranch
    // ref`) also closes one-of-four-CR's compute-name-vs-current-branch NIT.
    // Best-effort: a skip/block surfaces but never blocks the launch.
    if (!spawnedWorktreePath) {
        deps.runSync('git', ['fetch', 'origin', '--prune'], agentCwd);
        const wtBranch = perWorktreeBranchName(basename(agentCwd), basename(projectRoot));
        const adopt = adoptWorktree(deps.runSync, agentCwd, wtBranch, 'origin/main');
        if (adopt.action === 'adopted') {
            deps.stderr(`worktree: adopted branch ${wtBranch} at origin/main\n`);
            deps.stderr(renderInPlaceWorktreeNote(agentCwd, wtBranch));
        }
        else if (adopt.message) {
            deps.stderr(`worktree sync: ${adopt.message}\n`);
        }
    }
    // BUG-5 / v0.9.3: probe MCP readiness before launching claude so
    // the launched session sees tools at startup. Non-blocking: probe
    // failure surfaces a stderr warning but the launch proceeds (the
    // kickoff text's ToolSearch recovery clause is the second line of
    // defense).
    const mcpReady = await deps.probeMcpReady();
    if (!mcpReady) {
        deps.stderr(`warning: borg-mcp readiness probe did not complete within the timeout; ` +
            `launching ${cli} anyway — the kickoff prompt's ToolSearch fallback ` +
            `will recover if the MCP server takes longer to start.\n`);
    }
    const inboxPath = deps.getInboxPath(result.cube_id, result.drone_id);
    const codexWakeNonce = cli === 'codex' ? `borg-wake-${randomUUID()}` : null;
    // gh#929: shared wakePathArming + NEVER-TaskStop (unified with claude.ts —
    // the two call sites previously carried divergent monitorClause strings).
    const monitorClause = buildKickoffWakePathClause(cli, cli === 'claude' ? inboxPath : null, cli === 'claude' ? monitorStateRoot : null);
    let codexWakePathClause;
    let remoteArgs = [];
    let launchArgs;
    let codexSocketPath = null;
    let codexServerCleanup = null;
    const launchApproval = deps.resolveCliApprovals
        ? await deps.resolveCliApprovals(cli, agentCwd)
        : { codexArgs: [] };
    if (launchApproval.warning)
        deps.stderr(`warning: ${launchApproval.warning}\n`);
    // Temporary Claude-only model compatibility. Local/provider models are
    // configured by the selected agent CLI and are never rewritten by Borg.
    const modelEnv = resolveLaunchEnv(effectiveModel);
    const childEnv = {
        ...withAgentRuntimeEnv(process.env, cli),
        ...modelEnv.set,
        BORG_SESSION: '1',
    };
    if (cli === 'opencode' && launchApproval.openCodePermission) {
        childEnv.OPENCODE_PERMISSION = launchApproval.openCodePermission;
    }
    for (const key of modelEnv.unset) {
        delete childEnv[key];
    }
    if (cli === 'codex') {
        const remote = await deps.prepareCodexRemoteLaunch();
        if (remote.warning) {
            deps.stderr(`warning: ${remote.warning}\n`);
            codexWakePathClause =
                `⚠ Codex wake-path capability check failed: remote-control is unavailable for this session. Run borg_regen manually whenever you return, and expect only fallback wakeups until relaunch.`;
        }
        else {
            codexWakePathClause =
                `Codex wake-path capability check passed: remote-control socket established for this session.`;
        }
        remoteArgs = remote.args;
        // Codex env takes precedence over model env when there is overlap.
        if (Object.keys(remote.env).length > 0) {
            Object.assign(childEnv, remote.env);
        }
        codexSocketPath = socketPathFromRemoteArgs(remote.args);
        codexServerCleanup = remote.server?.cleanup ?? null;
    }
    const kickoff = buildAgentKickoffPrompt({
        cli,
        codexWakeNonce,
        monitorClause,
        codexWakePathClause,
    });
    // Keep Claude and Codex on the unmodified shared kickoff. Only OpenCode
    // receives a nonce-bearing copy so the later MCP connection can identify
    // this exact launch among same-text sessions.
    let openCodeKickoff = null;
    let dronePort;
    launchArgs = [kickoff];
    if (cli === 'codex') {
        // gh#673 P1-codex: -c overrides deliver BORG_SESSION and the selected
        // CLI identity to the codex-spawned borg-mcp child (inherited env never
        // reaches Codex MCP children — V2/V2b probes). Explicitly pin remote wake
        // off when no socket is available, overriding legacy static configs that
        // formerly used this transport marker as Codex identity.
        launchArgs = [
            ...launchApproval.codexArgs,
            ...codexBorgSessionConfigArgs(),
            ...codexAgentKindConfigArgs(),
            ...codexRemoteWakeConfigArgs(codexSocketPath !== null),
            ...remoteArgs,
            ...withCodexCwdArg(launchArgs, agentCwd),
        ];
    }
    else if (cli === 'opencode') {
        // OpenCode assimilate launch: start TUI with the kickoff passed via
        // --prompt (auto-submits it as the first message). BORG_SESSION is
        // pinned in opencode.json. A unique port is assigned so the MCP child
        // can connect via the HTTP API for context-streaming (injectOpenCodeEntry).
        dronePort = computeOpenCodePort(result.drone_id);
        installBorgPlugin();
        const cwd = agentCwd;
        openCodeKickoff = createOpenCodeLaunchKickoff(kickoff);
        launchArgs = buildOpenCodeLaunchArgs(cwd, dronePort, openCodeKickoff.prompt);
    }
    // gh#673 P1: mark the launched agent session as borg-launched so the
    // MCP child + hook bins activate (launch-gate.ts). childEnv is the
    // complete child environment (process.env + model.set, minus unset
    // keys, plus BORG_SESSION + codex env). The exec seam must use it
    // directly without re-merging process.env (assimilate-deps.ts).
    const exitPromise = deps.exec(cli, launchArgs, agentCwd, childEnv);
    if (cli === 'codex' && codexSocketPath && codexWakeNonce) {
        void recordCodexWakeTarget({
            deps,
            cubeId: result.cube_id,
            droneId: result.drone_id,
            socketPath: codexSocketPath,
            cwd: agentCwd,
            previewNeedle: codexWakeNonce,
            launchedAtSeconds: Math.floor(Date.now() / 1000),
        });
    }
    // gh#opencode: inject the kickoff prompt into the TUI's first session via
    // the SDK. OpenCode doesn't accept a prompt as a CLI arg, so we do it
    // programmatically once the HTTP server is ready. Best-effort.
    if (cli === 'opencode' && openCodeKickoff) {
        const launchKickoff = openCodeKickoff;
        const serverUrl = `http://127.0.0.1:${dronePort}`;
        connectOpenCodeDrone({
            serverUrl,
            directory: agentCwd,
            droneLabel: result.drone_label,
            cubeName: cubeName ?? 'borg',
        })
            .then(() => injectInitialKickoff(launchKickoff))
            .catch(() => { });
    }
    const exitCode = await exitPromise;
    // gh#528: kill the borg-owned Codex app-server when the assimilate-launched
    // session exits, so it isn't left orphaned (live → not pruned by pid liveness).
    // OpenCode has no app-server to clean up.
    if (codexServerCleanup) {
        try {
            codexServerCleanup();
        }
        catch {
            // best-effort
        }
    }
    // Sprint 18: when a sibling worktree was spawned, the user's shell
    // returns to their original cwd after Claude exits (process.chdir
    // doesn't propagate to the parent). Emit a stderr hint so they know
    // how to get back into the worktree. shellEscape defangs any shell
    // metachars in the path against paste-injection (drone-11 SR-LANE).
    // Skip the hint when no worktree was spawned (--here / no-worktree
    // flow) or when originalCwd already matches the worktree path
    // (defensive against the no-op edge case drone-9 UX-LANE flagged).
    if (spawnedWorktreePath && originalCwd !== spawnedWorktreePath) {
        deps.stderr(`\nAgent exited. You were working in ${spawnedWorktreePath}; your shell is back in ${originalCwd}.\n` +
            `To return:\n` +
            `  cd ${shellEscape(spawnedWorktreePath)}\n`);
    }
    return exitCode;
}
function renderWorktreeSteeringNote(worktreePath, wtBranch, primaryPath) {
    return (`\nWORKTREE STEERING: You are in worktree ${worktreePath} on branch ${wtBranch}. ` +
        `Do ALL work HERE — cut your feature branch (fix/.../feat/...) off ${wtBranch} in THIS worktree, ` +
        `use relative paths / your cwd. NEVER \`git -C ${primaryPath}\` or operate on the primary checkout ${primaryPath}: ` +
        `the same branch can't be checked out in two worktrees, so work created in the primary won't reach your wt-branch ` +
        `without manual surgery (cherry-pick/merge).\n`);
}
function renderInPlaceWorktreeNote(worktreePath, wtBranch) {
    return (`\nWORKTREE STEERING: This checkout is now on branch ${wtBranch}. ` +
        `Do ALL work HERE in ${worktreePath} — cut your feature branch (fix/.../feat/...) off ${wtBranch}, ` +
        `use relative paths / your cwd.\n`);
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
function worktreeRegistered(deps, projectRoot, candidate) {
    const res = deps.runSync('git', ['worktree', 'list', '--porcelain'], projectRoot);
    if (res.status !== 0)
        return false;
    return res.stdout.split('\n').some((line) => line === `worktree ${candidate}`);
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