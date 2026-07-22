/**
 * Real-IO factory for the `borg assimilate` orchestrator. Produces a
 * fully-wired `AssimilateDeps` whose seams call into the existing
 * client modules (remote-client HTTP, cubes.ts persistence, auth.ts
 * setup wizard, terminal-title helper).
 *
 * Test code never calls this — tests construct stub deps directly
 * (see `client/__tests__/assimilate-cmd.test.ts:makeStubDeps`).
 */
import { spawnSync, spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { hostname as osHostname, homedir as osHomedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import prompts from 'prompts';
import { readinessProbeEnv } from './readiness-probe.js';
import { resolveMcpBinaryPath } from './self-path.js';
import { listCubes as remoteListCubes, getCube as remoteGetCube, } from './remote-client.js';
import { DEFAULT_LOCAL_SERVER_ORIGIN, connectLocalBorgServer, createLocalBorgServerCube, enrollLocalBorgServer, probeLocalBorgServer, resumeLocalBorgServerEnrollment, sendBorgServerAttach, } from './server-handshake.js';
import { findIncompleteSiblingAttempt, observeSeat, prepareSeat, seatRef, } from './seats.js';
import { readPersistedLocalSeat, } from './cubes.js';
import { loadBorgServerTrust } from './server-trust.js';
import { defaultProbeSeat } from './seat-probe.js';
import { BorgServerError } from './server-errors.js';
import { findProjectRoot as cubesFindProjectRoot, getActiveCube as cubesGetActive, hasPersistedActiveCube as cubesHasPersistedActive, setActiveCube as cubesSetActive, inboxPathForDrone, setCodexWakeTarget, } from './cubes.js';
import { addProjectSessionStartHook } from './config-utils.js';
import { setTerminalTitle as setTitle } from './terminal-title.js';
import { defaultCliChoiceDeps, resolveCliChoice } from './cli-platform.js';
import { prepareCodexRemoteLaunch, defaultCodexRemoteDeps } from './codex-remote.js';
import { findLoadedCodexThread } from './codex-app-server.js';
import { defaultApprovalIo, resolveLaunchBorgApprovals } from './cli-tool-approval.js';
export function buildDefaultAssimilateDeps() {
    return {
        runSync: (cmd, args, cwd) => {
            const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
            return {
                status: r.status,
                stdout: r.stdout ?? '',
                stderr: r.stderr ?? '',
            };
        },
        pathExists: (p) => existsSync(p),
        cwd: () => process.cwd(),
        chdir: (p) => process.chdir(p),
        // gh#556 Part 1: ~/.borg/worktrees relocation. homedir seams $HOME;
        // mkdirp is a plain recursive create (NO chmod of existing parents — the
        // ~/.borg credentials file's perms stay untouched).
        homedir: () => osHomedir(),
        mkdirp: (dir) => mkdirSync(dir, { recursive: true }),
        exec: (cmd, args, cwd, env) => new Promise((resolveExit, rejectExit) => {
            // assimilate-cmd builds the complete child env before calling exec. Use
            // it directly so caller-selected runtime values are not overwritten.
            const child = spawnChild(cmd, args, {
                cwd,
                stdio: 'inherit',
                shell: false,
                env: env ?? process.env,
            });
            child.on('error', rejectExit);
            child.on('exit', (code) => resolveExit(code ?? 0));
        }),
        stderr: (line) => process.stderr.write(line),
        stdout: (line) => process.stdout.write(line),
        prompt: async (message) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await rl.question(message);
            }
            finally {
                rl.close();
            }
        },
        promptSecret: async (message) => {
            const result = await prompts({
                type: 'password',
                name: 'invitation',
                message,
            });
            return typeof result.invitation === 'string' ? result.invitation : '';
        },
        isTTY: () => process.stdin.isTTY === true,
        resolveCliApprovals: (cli, cwd) => resolveLaunchBorgApprovals(cli, defaultApprovalIo(async (message) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await rl.question(message);
            }
            finally {
                rl.close();
            }
        }, () => process.stdin.isTTY === true, { cwd, env: process.env, codexArgs: [] })),
        getHostname: () => osHostname(),
        setTerminalTitle: (label, cubeName) => {
            setTitle({ label, cubeName }, cubeName);
        },
        getActiveCube: () => cubesGetActive(),
        hasPersistedActiveCube: () => cubesHasPersistedActive(),
        readPersistedLocalSeat: () => readPersistedLocalSeat(),
        peekServerSessionRecord: async (credentialRef, binding) => (await observeSeat(credentialRef, binding)).state !== 'absent',
        // CR#3: recover an in-flight implicit-sibling attempt (unbound pending sibling
        // record) by source repo, so a rerun re-derives the EXACT seat + reuses the bearer.
        findIncompleteSiblingAttempt: async (binding) => {
            const record = await findIncompleteSiblingAttempt(binding);
            if (!record)
                return null;
            return { operation: record.operation, roleId: record.roleId, credentialRef: seatRef(record) };
        },
        probeSeat: (sessionToken, apiUrl, serverTrustIdentity) => defaultProbeSeat(sessionToken, apiUrl, serverTrustIdentity),
        setActiveCube: (a) => cubesSetActive(a),
        // Single-store FINALIZE: the merged activate+bind (reached via the injected
        // `activate` thunk from sendBorgServerAttach) stamps the exact
        // digest-matched PENDING record ACTIVE and binds the decided worktree in ONE
        // atomic commit. PREPARE-time revalidation already ran (prepareSeat), so the
        // only outcomes here are committed or a post-mint activation failure (CR#5:
        // missing/replaced/throw → the pending record is the rerunnable locator; the
        // caller PRESERVES the worktree). expectation-mismatch is produced upstream at
        // PREPARE (result.prepareAborted), never here.
        finalizeServerSeat: async ({ active, activate }) => {
            const binding = {
                worktree: cubesFindProjectRoot(process.cwd()),
                name: active.name,
                droneLabel: active.droneLabel,
                ...(active.roleName !== undefined ? { roleName: active.roleName } : {}),
                ...(active.roleClass !== undefined ? { roleClass: active.roleClass } : {}),
                ...(active.isHumanSeat !== undefined ? { isHumanSeat: active.isHumanSeat } : {}),
            };
            let outcome;
            try {
                outcome = (await activate(binding));
            }
            catch {
                return { committed: false, reason: 'activation-failed' };
            }
            return outcome === 'activated'
                ? { committed: true }
                : { committed: false, reason: 'activation-failed' };
        },
        findProjectRoot: (cwd) => cubesFindProjectRoot(cwd),
        // gh#673 P2 (WI-1): project-local SessionStart hook for the launch root.
        installProjectSessionHook: (projectRoot) => {
            addProjectSessionStartHook(projectRoot);
        },
        // #1015: discovery is advisory but still verifies the server-owned CA.
        detectLocalServer: async () => (await probeLocalBorgServer(DEFAULT_LOCAL_SERVER_ORIGIN))
            ? DEFAULT_LOCAL_SERVER_ORIGIN
            : null,
        connectServer: async (apiUrl, enrollment) => {
            if (enrollment) {
                return enrollLocalBorgServer(apiUrl, enrollment.invitation, {
                    clientName: osHostname(),
                });
            }
            return connectLocalBorgServer(apiUrl);
        },
        resumeServerEnrollment: async (apiUrl, onPending) => resumeLocalBorgServerEnrollment(apiUrl, {
            ...(onPending === undefined ? {} : { onPending }),
        }),
        listCubes: async (apiUrl, token, serverTrustIdentity) => {
            if (serverTrustIdentity === undefined) {
                throw new Error('Selected Borg server authority state is missing or unreadable');
            }
            const { cubes } = await remoteListCubes({
                apiUrl,
                authToken: token,
                serverTrustIdentity,
            });
            return cubes.map((c) => ({ id: c.id, name: c.name }));
        },
        getCube: async (apiUrl, token, cubeId, serverTrustIdentity) => {
            if (serverTrustIdentity === undefined) {
                throw new Error('Selected Borg server authority state is missing or unreadable');
            }
            // BUG-2 fix (v0.9.2): remote-client now unwraps the server's
            // `{cube, roles, drones}` shape, so the returned object is
            // already flat with id/name/roles at the top level.
            const cube = await remoteGetCube(cubeId, {
                apiUrl,
                authToken: token,
                serverTrustIdentity,
            });
            return {
                id: cube.id,
                name: cube.name,
                roles: cube.roles,
                drones: (cube.drones ?? []).map((d) => ({ role_id: d.role_id })),
            };
        },
        createCube: async (apiUrl, token, params, serverTrustIdentity) => {
            if (serverTrustIdentity === undefined) {
                throw new Error('Selected Borg server authority state is missing or unreadable');
            }
            {
                if (!params.name || !params.projectRoot) {
                    throw new Error('Local Borg server cube creation requires a repository name and root');
                }
                const created = await createLocalBorgServerCube(apiUrl, serverTrustIdentity, token, { projectRoot: params.projectRoot, name: params.name });
                const cube = await remoteGetCube(created.cube_id, {
                    apiUrl,
                    authToken: token,
                    serverTrustIdentity,
                });
                if (cube.id !== created.cube_id ||
                    !Array.isArray(cube.roles) ||
                    !cube.roles.some((role) => role.id === created.default_worker_role_id)) {
                    throw new Error('Borg server returned cube details outside the creation result');
                }
                return {
                    id: cube.id,
                    name: cube.name,
                    roles: cube.roles,
                    drones: cube.drones ?? [],
                };
            }
        },
        assimilate: async (apiUrl, token, params, serverTrustIdentity) => {
            if (serverTrustIdentity === undefined) {
                throw new Error('Selected Borg server authority state is missing or unreadable');
            }
            {
                if (params.session_operation === undefined) {
                    throw new Error('Borg server attach operation identity is missing');
                }
                const operation = params.session_operation;
                const trust = await loadBorgServerTrust(apiUrl);
                if (trust.identity !== serverTrustIdentity) {
                    throw new Error('Borg server trust identity changed; refusing the attach');
                }
                // CR #1: MINT under the SINGLE store flock via prepareSeat, which REVALIDATES
                // the typed prepare-time expectation and mints the PENDING record in one lock
                // hold — so a reset/writer that wins before PREPARE aborts the attach here
                // before any credential is created or sent. Eviction-remint discards the
                // known-invalid saved record (scrubBeforeMint) in the same flock. A fresh
                // sibling spawn has no in-place binding to revalidate, so it passes
                // revalidate:false but still mints under the one flock (never a bypass). The
                // client CSPRNG-generates the bearer here; a lost-response retry / crash-in-gap
                // is recovered by prepareSeat's idempotent mint-or-reuse (identical bearer).
                const seed = {
                    origin: apiUrl,
                    trustIdentity: serverTrustIdentity,
                    cubeId: params.cube_id,
                    roleId: params.role_id,
                    operation,
                    credential: randomBytes(32).toString('base64url'),
                };
                const preparedMint = await prepareSeat({
                    expected: params.session_expected ?? { kind: 'absent' },
                    revalidate: params.revalidate_at_prepare === true && params.session_expected !== undefined,
                    scrubBeforeMint: params.remint_invalid_prior === true,
                    seed,
                });
                if (!preparedMint.ok) {
                    return {
                        cube_id: params.cube_id,
                        drone_id: '',
                        drone_label: '',
                        role_id: params.role_id,
                        prepareAborted: true,
                    };
                }
                const pending = preparedMint.record;
                // Network only — the pending→ACTIVE flip + worktree BIND are merged into the
                // single-store activate+bind op, deferred to the FINALIZE thunk so the
                // binding lands ATOMICALLY WITH activation (ACTIVE-without-binding unreachable).
                const prepared = await sendBorgServerAttach(apiUrl, serverTrustIdentity, token, {
                    cubeId: params.cube_id,
                    roleId: params.role_id,
                    operation,
                    ...(params.prior_drone_id === undefined
                        ? {}
                        : { priorDroneId: params.prior_drone_id }),
                }, pending.credential, { fetchImpl: trust.fetchImpl });
                if (params.prior_drone_id) {
                    // The seat identity did not match the reattach/remint intent. Scrub the
                    // caller's own pending record (no-op unless it is still ours + pending)
                    // before surfacing, so no orphan pending lingers.
                    if (params.remint_invalid_prior) {
                        if (prepared.result !== 'created' || prepared.drone.id === params.prior_drone_id) {
                            await prepared.scrubPending();
                            throw new Error('Borg server did not remint a fresh seat after eviction');
                        }
                    }
                    else if (prepared.result !== 'reused' || prepared.drone.id !== params.prior_drone_id) {
                        await prepared.scrubPending();
                        throw new BorgServerError('ATTACH_CONFLICT', 'Borg server did not reattach the saved seat');
                    }
                }
                return {
                    cube_id: prepared.cube.id,
                    drone_id: prepared.drone.id,
                    drone_label: prepared.drone.label,
                    role_id: prepared.role.id,
                    result: prepared.result,
                    local_session: {
                        credential_ref: prepared.credentialRef,
                    },
                    // Handles for the cube-lock-held FINALIZE (assimilate-cmd Step 8).
                    finalize: {
                        activate: prepared.activate,
                        scrubPending: prepared.scrubPending,
                        // CR#2: bind the surviving PENDING record to the preserved worktree on an
                        // activation failure so the rerun-from-there resumes the exact operation.
                        bindPending: prepared.bindPending,
                    },
                };
            }
        },
        // CR-PE-F1 wiring (Phase E merge brought this seam in): compute the
        // inbox file path used by the borg-inbox-monitor command in step 8
        // kickoff. Pure helper from cubes.ts; same computation claude.ts uses.
        getInboxPath: (cubeId, droneId) => inboxPathForDrone(cubeId, droneId),
        // BUG-5 / v0.9.3 wiring: spawn `borg-mcp` as a stdio child, send
        // an initialize request, await a response (or timeout), then kill
        // the child. Probe success indicates the MCP server starts cleanly
        // and tools/list is reachable; failure means the launched Claude
        // session will hit the race and need the kickoff prompt's
        // ToolSearch recovery clause.
        probeMcpReady: () => new Promise((resolveProbe) => {
            // gh#client#18: use absolute path to THIS installation's binary so the
            // readiness probe starts the same server version that will be registered.
            const child = spawnChild(resolveMcpBinaryPath(), [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
                env: readinessProbeEnv(),
            });
            let buffer = '';
            let settled = false;
            const settle = (result) => {
                if (settled)
                    return;
                settled = true;
                try {
                    child.kill('SIGTERM');
                }
                catch { /* ignore */ }
                resolveProbe(result);
            };
            const timeout = setTimeout(() => settle(false), 2000);
            child.on('error', () => { clearTimeout(timeout); settle(false); });
            child.on('exit', () => { clearTimeout(timeout); settle(settled); });
            child.stdout?.on('data', (chunk) => {
                buffer += chunk.toString('utf-8');
                // initialize response contains "result" with "protocolVersion"
                // and "capabilities". Light parse: line-buffered JSON-RPC.
                for (const line of buffer.split('\n')) {
                    if (line.includes('"protocolVersion"') && line.includes('"result"')) {
                        clearTimeout(timeout);
                        settle(true);
                        return;
                    }
                }
            });
            const initReq = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'borg-assimilate-probe', version: '0.9.3' },
                },
            });
            try {
                child.stdin?.write(initReq + '\n');
            }
            catch {
                clearTimeout(timeout);
                settle(false);
            }
        }),
        resolveCli: (explicit) => resolveCliChoice(explicit, defaultCliChoiceDeps(async (message) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await rl.question(message);
            }
            finally {
                rl.close();
            }
        }, () => process.stdin.isTTY === true)),
        prepareCodexRemoteLaunch: () => prepareCodexRemoteLaunch(defaultCodexRemoteDeps()),
        setCodexWakeTarget,
        findLoadedCodexThread,
    };
}
//# sourceMappingURL=assimilate-deps.js.map