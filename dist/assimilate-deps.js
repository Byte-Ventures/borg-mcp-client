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
import { existsSync, mkdirSync } from 'node:fs';
import { hostname as osHostname, homedir as osHomedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import prompts from 'prompts';
import { readinessProbeEnv } from './readiness-probe.js';
import { resolveMcpBinaryPath } from './self-path.js';
import { listCubes as remoteListCubes, getCube as remoteGetCube, createCube as remoteCreateCube, assimilate as remoteAssimilate, listTemplates as remoteListTemplates, } from './remote-client.js';
import { DEFAULT_LOCAL_SERVER_ORIGIN, connectLocalBorgServer, createLocalBorgServerCube, enrollLocalBorgServer, probeLocalBorgServer, resumeLocalBorgServerEnrollment, prepareBorgServerAttach, } from './server-handshake.js';
import { clearPendingServerSession, peekServerSessionRecord, } from './config.js';
import { finalizeServerSeatAttachment, readPersistedLocalSeat } from './cubes.js';
import { loadBorgServerTrust } from './server-trust.js';
import { defaultProbeSeat } from './seat-probe.js';
import { BorgServerError } from './server-errors.js';
import { findProjectRoot as cubesFindProjectRoot, getActiveCube as cubesGetActive, hasPersistedActiveCube as cubesHasPersistedActive, setActiveCube as cubesSetActive, clearActiveCube as cubesClearActive, inboxPathForDrone, setCodexWakeTarget, } from './cubes.js';
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
        peekServerSessionRecord: (credentialRef, binding) => peekServerSessionRecord(credentialRef, binding),
        clearActiveCube: (expected) => cubesClearActive(expected),
        probeSeat: (sessionToken, apiUrl, serverTrustIdentity) => defaultProbeSeat(sessionToken, apiUrl, serverTrustIdentity),
        setActiveCube: (a) => cubesSetActive(a),
        finalizeServerSeat: (input) => finalizeServerSeatAttachment(input),
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
            const { cubes } = await remoteListCubes({
                apiUrl,
                authToken: token,
                ...(serverTrustIdentity === undefined ? {} : { serverTrustIdentity }),
            });
            return cubes.map((c) => ({ id: c.id, name: c.name }));
        },
        getCube: async (apiUrl, token, cubeId, serverTrustIdentity) => {
            // BUG-2 fix (v0.9.2): remote-client now unwraps the server's
            // `{cube, roles, drones}` shape, so the returned object is
            // already flat with id/name/roles at the top level.
            const cube = await remoteGetCube(cubeId, {
                apiUrl,
                authToken: token,
                ...(serverTrustIdentity === undefined ? {} : { serverTrustIdentity }),
            });
            return {
                id: cube.id,
                name: cube.name,
                roles: cube.roles,
                drones: (cube.drones ?? []).map((d) => ({ role_id: d.role_id })),
            };
        },
        createCube: async (apiUrl, token, params, serverTrustIdentity) => {
            if (serverTrustIdentity !== undefined) {
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
            const cube = await remoteCreateCube(params.name, '', params.template ? { template: params.template } : undefined, {
                apiUrl,
                authToken: token,
                ...(serverTrustIdentity === undefined ? {} : { serverTrustIdentity }),
            });
            return { id: cube.id, name: cube.name, roles: cube.roles };
        },
        assimilate: async (apiUrl, token, params, serverTrustIdentity) => {
            if (serverTrustIdentity !== undefined) {
                if (params.session_operation === undefined) {
                    throw new Error('Borg server attach operation identity is missing');
                }
                const operation = params.session_operation;
                const seatBinding = {
                    origin: apiUrl,
                    trustIdentity: serverTrustIdentity,
                    cubeId: params.cube_id,
                    roleId: params.role_id,
                    operation,
                };
                const trust = await loadBorgServerTrust(apiUrl);
                if (trust.identity !== serverTrustIdentity) {
                    throw new Error('Borg server trust identity changed; refusing the attach');
                }
                // Eviction-remint: discard the known-invalid saved bearer BEFORE the
                // attach so a genuinely fresh bearer (and therefore a new seat) is minted
                // instead of the server reusing the evicted seat's digest.
                if (params.remint_invalid_prior === true) {
                    await clearPendingServerSession(seatBinding);
                }
                // PREPARE + network only — the keychain pending→ACTIVE flip is deferred to
                // the cube-lock-held FINALIZE (finalizeServerSeatAttachment) so the binding
                // lands BEFORE the credential goes active (Race 2 / ACTIVE-without-binding).
                const prepared = await prepareBorgServerAttach(apiUrl, serverTrustIdentity, token, {
                    cubeId: params.cube_id,
                    roleId: params.role_id,
                    operation,
                    ...(params.prior_drone_id === undefined
                        ? {}
                        : { priorDroneId: params.prior_drone_id }),
                }, { fetchImpl: trust.fetchImpl });
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
                        expires_at: prepared.session.expiresAt,
                    },
                    // Handles for the cube-lock-held FINALIZE (assimilate-cmd Step 8).
                    finalize: {
                        activate: prepared.activate,
                        scrubPending: prepared.scrubPending,
                    },
                };
            }
            // The backend persists a model only for a known agent kind.
            const result = await remoteAssimilate({
                cube_id: params.cube_id,
                role_id: params.role_id,
                // gh#780: reattach hint for the --here same-cube recovery flow.
                ...(params.prior_drone_id ? { prior_drone_id: params.prior_drone_id } : {}),
                // Task 25: send effective model to worker so it can persist it.
                ...(params.model != null ? { model: params.model } : {}),
            }, apiUrl, params.hostname ?? null, params.agent_kind ?? null, token, serverTrustIdentity);
            return {
                cube_id: result.cube.id,
                drone_id: result.drone.id,
                drone_label: result.drone.label,
                session_token: result.sessionToken,
                role_id: result.role.id,
                // Map the cloud gh#780 reattach hint onto the unified result discriminant
                // so the same "reused" display path serves cloud and local authorities.
                result: result.reattached === true ? 'reused' : 'created',
            };
        },
        listTemplates: async (apiUrl, token, serverTrustIdentity) => {
            const { templates } = await remoteListTemplates({
                apiUrl,
                authToken: token,
                ...(serverTrustIdentity === undefined ? {} : { serverTrustIdentity }),
            });
            return templates.map((t) => ({ name: t.name, description: t.description }));
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