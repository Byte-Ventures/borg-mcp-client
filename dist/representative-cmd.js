/**
 * `borg representative <prepare|status|mcp>` — operator entry for the human
 * representative ("Hermes") connection.
 *
 * prepare  binds ONE dedicated non-human-seat drone in this repository's cube
 *          to ONE explicitly named Coordinator drone. It creates/resumes the
 *          seat through the launch-free assimilate seam: no agent CLI starts
 *          and no existing drone's identity is touched.
 * status   shows the saved binding and re-checks it against the live cube.
 * mcp      serves the restricted stdio MCP facade for a generic MCP host.
 *
 * No command accepts a credential: the seat bearer stays in the private seat
 * store and is hydrated in-process only.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { normalizeServerEndpoint } from './server-endpoint.js';
import { validateName } from './name-validator.js';
import { RepresentativeError, assertRepresentativeRole, representativeStateProblemStatus, representativeStatus, resolveCoordinator, } from './representative-core.js';
import { RepresentativeStoreError, bindingFingerprint, representativeRecoveryCommand, } from './representative-store.js';
import { RepresentativeStateError, printable } from './representative-db.js';
import { shellEscape } from './shell-escape.js';
export const DEFAULT_REPRESENTATIVE_ROLE = 'hermes-representative';
export function parseRepresentativeArgs(args) {
    const [action, ...rest] = args;
    if (action === 'hermes-plugin')
        return parseHermesPluginArgs(rest);
    if (action === 'reset-state') {
        return rest.length === 0
            ? { ok: true, command: { action: 'reset-state' } }
            : { ok: false, error: `unknown argument: ${rest[0]}. reset-state takes no arguments` };
    }
    if (action !== 'prepare' && action !== 'status' && action !== 'mcp' && action !== 'listen') {
        return { ok: false, error: 'expected one of: prepare, status, mcp, listen, reset-state, hermes-plugin' };
    }
    const values = {};
    let rebind = false;
    const valueFlags = action === 'prepare' ? ['--coordinator', '--role', '--worktree', '--host'] : action === 'listen' ? ['--worktree', '--protocol'] : ['--worktree'];
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (action === 'prepare' && arg === '--rebind') {
            rebind = true;
        }
        else if (valueFlags.includes(arg)) {
            const next = rest[i + 1];
            if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
                return { ok: false, error: `${arg} requires a value` };
            }
            values[arg] = next;
            i += 1;
        }
        else {
            return {
                ok: false,
                error: `unknown argument: ${arg}. Supported: ${[...valueFlags, ...(action === 'prepare' ? ['--rebind'] : [])].join(', ')}`,
            };
        }
    }
    if (action !== 'prepare') {
        const worktree = values['--worktree'];
        if (worktree !== undefined && !isAbsolute(worktree)) {
            return { ok: false, error: '--worktree must be an absolute path to the representative worktree' };
        }
        const protocol = values['--protocol'];
        if (protocol !== undefined && !/^[1-9]\d{0,2}$/.test(protocol)) {
            return { ok: false, error: '--protocol must be a protocol number (this version speaks 2)' };
        }
        return { ok: true, command: { action, ...(worktree ? { worktree } : {}), ...(protocol ? { protocol: Number(protocol) } : {}) } };
    }
    const coordinator = values['--coordinator'];
    if (!coordinator) {
        return {
            ok: false,
            error: '--coordinator <drone-label> is required: name the exact Coordinator drone (see `borg drones`). It is never chosen for you.',
        };
    }
    const role = values['--role'] ?? DEFAULT_REPRESENTATIVE_ROLE;
    if (!validateName(role).ok)
        return { ok: false, error: '--role must be a valid role name' };
    if (values['--worktree'] !== undefined && !validateName(values['--worktree']).ok) {
        return { ok: false, error: '--worktree for prepare is a new worktree NAME (as in `borg assimilate --worktree`), not a path' };
    }
    return {
        ok: true,
        command: {
            action,
            coordinator,
            role,
            rebind,
            ...(values['--worktree'] ? { worktreeName: values['--worktree'] } : {}),
            ...(values['--host'] ? { host: values['--host'] } : {}),
        },
    };
}
function parseHermesPluginArgs(args) {
    const [subcommand, ...rest] = args;
    if (subcommand !== 'install')
        return { ok: false, error: 'expected: hermes-plugin install [--hermes-home <path>] [--force]' };
    let hermesHome;
    let force = false;
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === '--force') {
            force = true;
        }
        else if (arg === '--hermes-home') {
            const next = rest[i + 1];
            if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
                return { ok: false, error: '--hermes-home requires a value' };
            }
            if (!isAbsolute(next))
                return { ok: false, error: '--hermes-home must be an absolute path' };
            hermesHome = next;
            i += 1;
        }
        else {
            return { ok: false, error: `unknown argument: ${arg}. Supported: --hermes-home, --force` };
        }
    }
    return { ok: true, command: { action: 'hermes-plugin-install', force, ...(hermesHome ? { hermesHome } : {}) } };
}
function canonicalWorktree(path, deps) {
    let real = resolve(path);
    try {
        real = realpathSync(real);
    }
    catch {
        /* a missing path simply finds no binding below */
    }
    return deps.findProjectRoot(real);
}
function describeError(error) {
    if (error instanceof RepresentativeError || error instanceof RepresentativeStoreError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}
function sameSeat(binding, active) {
    return active.cubeId === binding.cubeId &&
        active.droneId === binding.representativeDroneId &&
        active.apiUrl === binding.origin &&
        active.serverTrustIdentity === binding.trustIdentity;
}
/**
 * Load the saved binding and prove the worktree's hydrated seat is still that
 * exact seat. Fails closed. `initialize` creates the state first when none
 * exists (mcp and listen; the first generation imports 5.x bindings once);
 * status never creates anything.
 */
export async function resolveRepresentativeContext(worktree, deps, options = {}) {
    if (options.initialize)
        await deps.store.initialize();
    const binding = await deps.store.getBinding(worktree);
    if (!binding) {
        const created = options.initialize || await deps.store.initialized();
        throw new RepresentativeError('NOT_PREPARED', `No representative connection is prepared for ${worktree}. Run \`borg representative prepare --coordinator <drone-label>\` there first.` +
            (created ? '' : ' No representative state exists yet: a worktree prepared by borgmcp 5.x is imported when ' +
                '`borg representative mcp` or `listen` first starts.'));
    }
    const active = await deps.hydrateSeat(worktree);
    if (!active) {
        throw new RepresentativeError('SEAT_UNAVAILABLE', `The saved representative connection is missing, reset or rejected. Run \`${representativeRecoveryCommand(binding)}\`.`);
    }
    if (!sameSeat(binding, active)) {
        throw new RepresentativeError('BINDING_MISMATCH', `This worktree's saved connection is not the bound server/cube/drone. Run \`${representativeRecoveryCommand(binding)}\` to confirm a rebind; nothing is sent until then.`);
    }
    return { binding, backend: await deps.backendFor(active), store: deps.store };
}
export function hermesConfigSnippet(worktree) {
    return (`mcp_servers:\n` +
        `  borg-representative:\n` +
        `    command: borg\n` +
        `    args: ["representative", "mcp", "--worktree", ${JSON.stringify(worktree)}]\n`);
}
export async function runRepresentativePrepare(command, deps) {
    try {
        // Same canonical key as status/mcp, so a symlinked cwd cannot bind under a path they never look up.
        let worktree = canonicalWorktree(deps.cwd(), deps);
        const existing = command.worktreeName === undefined ? await deps.hydrateSeat(worktree) : null;
        if (existing && command.host && normalizeServerEndpoint(command.host) !== normalizeServerEndpoint(existing.apiUrl)) {
            throw new RepresentativeError('BINDING_MISMATCH', 'The explicit --host does not match this worktree\'s saved connection. Use a worktree connected to the requested server; nothing was rebound.');
        }
        const prepared = await deps.prepareSeat({
            role: command.role,
            coordinator: command.coordinator,
            ...(existing ? { resume: true } : {}),
            ...(command.worktreeName ? { worktreeName: command.worktreeName } : {}),
            ...(command.host ? { host: command.host } : {}),
        });
        if (prepared.code !== 0) {
            deps.stderr('borg representative: the representative connection could not be prepared; nothing was bound.\n');
            return prepared.code || 1;
        }
        if (prepared.worktree)
            worktree = canonicalWorktree(prepared.worktree, deps);
        const active = await deps.hydrateSeat(worktree);
        if (!active || !active.serverTrustIdentity) {
            throw new RepresentativeError('SEAT_UNAVAILABLE', `No usable saved connection was found for ${worktree}.`);
        }
        const backend = await deps.backendFor(active);
        const me = await backend.whoami();
        if (me.cube_id !== active.cubeId || me.drone_id !== active.droneId) {
            throw new RepresentativeError('BINDING_MISMATCH', 'The server does not recognise this worktree\'s saved connection.');
        }
        const roster = await backend.roster();
        const self = roster.drones.find((drone) => drone.id === me.drone_id);
        const selfRole = roster.roles.find((role) => role.id === self?.role_id);
        if (!self || !selfRole)
            throw new RepresentativeError('SEAT_UNAVAILABLE', 'The representative drone is not active in the cube.');
        assertRepresentativeRole(selfRole, self);
        if (selfRole.name.toLowerCase() !== command.role.toLowerCase()) {
            throw new RepresentativeError('REPRESENTATIVE_ROLE_MISMATCH', `This worktree's drone ${self.label} holds role ${JSON.stringify(selfRole.name)}, not ${JSON.stringify(command.role)}. ` +
                'The representative needs its own dedicated drone. Use the preparation syntax in `borg representative --help` with an explicit Coordinator and the intended role or new worktree name.');
        }
        const coordinator = resolveCoordinator(roster, { label: command.coordinator, selfDroneId: me.drone_id });
        const binding = {
            worktree,
            origin: active.apiUrl,
            trustIdentity: active.serverTrustIdentity,
            cubeId: me.cube_id,
            cubeName: me.cube_name,
            representativeDroneId: me.drone_id,
            representativeLabel: me.drone_label,
            representativeRoleName: selfRole.name,
            coordinatorDroneId: coordinator.drone.id,
            coordinatorLabel: coordinator.drone.label,
            coordinatorRoleName: coordinator.role.name,
            ...(active.repositoryOrigin ? { repositoryOrigin: active.repositoryOrigin } : {}),
            boundAt: new Date().toISOString(),
        };
        const outcome = await deps.store.saveBinding(binding, { rebind: command.rebind });
        deps.stdout(`◼ Human representative connection ${outcome === 'unchanged' ? 'resumed' : outcome}.\n` +
            `  cube:            ${binding.cubeName} (${binding.cubeId})\n` +
            `  representative:  ${binding.representativeLabel} — role ${binding.representativeRoleName} (not a human seat)\n` +
            `  coordinator:     ${binding.coordinatorLabel} — role ${binding.coordinatorRoleName} (human seat)\n` +
            `  worktree:        ${worktree}\n\n` +
            `No agent CLI was launched. Serve it to a generic MCP host with:\n` +
            `  borg representative mcp --worktree ${worktree}\n\n` +
            `Example host configuration (no secrets belong here):\n${hermesConfigSnippet(worktree)}`);
        return 0;
    }
    catch (error) {
        deps.stderr(`◼ borg representative prepare: ${describeError(error)}\n`);
        return 1;
    }
}
export async function runRepresentativeStatus(command, deps) {
    try {
        const worktree = canonicalWorktree(command.worktree ?? deps.cwd(), deps);
        let ctx;
        try {
            ctx = await resolveRepresentativeContext(worktree, deps);
        }
        catch (error) {
            // An unusable state database is itself the status to report: status
            // never needs a binding to say so.
            if (!(error instanceof RepresentativeStateError))
                throw error;
            deps.stdout(`${JSON.stringify(representativeStateProblemStatus(worktree, error), null, 2)}\n`);
            return 1;
        }
        const status = await representativeStatus(ctx);
        const { representativeListenerStatus } = await import('./representative-listener.js');
        const listener = await representativeListenerStatus(ctx.binding, deps.store);
        deps.stdout(`${JSON.stringify({ ...status, listener }, null, 2)}\n`);
        return status.connected ? 0 : 1;
    }
    catch (error) {
        deps.stderr(`◼ borg representative status: ${describeError(error)}\n`);
        return 1;
    }
}
/**
 * Serve the stdio facade. The binding selection is captured at startup; a later
 * operator rebind is NOT picked up by a running process — calls fail closed
 * until the host restarts it.
 */
export async function runRepresentativeMcp(command, deps, io) {
    let worktree;
    let pinned = null;
    let unusable = null;
    try {
        worktree = canonicalWorktree(command.worktree ?? deps.cwd(), deps);
        try {
            pinned = (await resolveRepresentativeContext(worktree, deps, { initialize: true })).binding;
        }
        catch (error) {
            // An unusable state database still serves status (reporting it); every
            // other tool refuses with this error until reset-state and a restart.
            if (!(error instanceof RepresentativeStateError))
                throw error;
            unusable = error;
        }
        const active = await deps.hydrateSeat(worktree);
        if (active)
            io.pinSeat?.(active);
    }
    catch (error) {
        // stdout is reserved for JSON-RPC frames; refuse to start on stderr only.
        deps.stderr(`◼ borg representative mcp: ${describeError(error)}\n`);
        return 1;
    }
    const { serveRepresentativeMcp } = await import('./representative-mcp.js');
    const served = await serveRepresentativeMcp({
        version: io.version,
        onClose: () => deps.store.state.close(),
        ...(io.stdin ? { stdin: io.stdin } : {}),
        ...(io.stdout ? { stdout: io.stdout } : {}),
        // The full generation, so any rebind (same selection included) is refused.
        ...(pinned ? { pinnedFingerprint: bindingFingerprint(pinned) } : {}),
        context: async () => {
            if (unusable)
                throw unusable;
            return resolveRepresentativeContext(worktree, deps);
        },
        stateProblemStatus: (error) => representativeStateProblemStatus(worktree, error),
    });
    const stdin = io.stdin ?? process.stdin;
    stdin.once('end', () => { void served.close(); });
    await served.closed;
    return 0;
}
export async function buildDefaultRepresentativeDeps() {
    const [{ findProjectRoot, getActiveCubeForWorktree }, { createSeatBackend }, { createRepresentativeStore }] = await Promise.all([
        import('./cubes.js'),
        import('./representative-core.js'),
        import('./representative-store.js'),
    ]);
    return {
        cwd: () => process.cwd(),
        findProjectRoot,
        hydrateSeat: (worktree) => getActiveCubeForWorktree(worktree),
        prepareSeat: async ({ role, coordinator, worktreeName, host, resume }) => {
            const [{ prepareConnection }, { buildDefaultAssimilateDeps }] = await Promise.all([
                import('./assimilate-cmd.js'),
                import('./assimilate-deps.js'),
            ]);
            let worktree;
            const code = await prepareConnection({ role, flags: { ...(resume ? { here: true } : {}), ...(worktreeName ? { worktree: worktreeName } : {}), ...(host ? { server: host } : {}) } }, buildDefaultAssimilateDeps(), {
                validateRole: assertRepresentativeRole,
                onPrepared: (prepared) => { worktree = prepared.worktree; },
                authoritySelectionCommand: 'borg representative prepare --host <host>' +
                    (coordinator ? ` --coordinator ${shellEscape(coordinator)}` : '') +
                    ` --role ${shellEscape(role)}` +
                    (worktreeName ? ` --worktree ${shellEscape(worktreeName)}` : ''),
            });
            return { code, ...(worktree ? { worktree } : {}) };
        },
        backendFor: createSeatBackend,
        store: createRepresentativeStore(),
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    };
}
/**
 * Disaster recovery for a corrupt representative state database. Refuses on a
 * healthy database; otherwise publishes a new generation with the salvageable
 * bindings and reports exactly what was lost.
 */
export async function runRepresentativeResetState(deps, reset = defaultReset) {
    try {
        const report = await reset();
        if (report.outcome === 'not-initialized') {
            deps.stdout('No representative state exists yet; nothing to reset.\n');
            return 0;
        }
        // Every value printed here may come from a damaged database or the
        // filesystem: control characters are escaped, never sent to the terminal.
        const show = (values) => values.map(printable).join(', ');
        if (report.outcome === 'healthy') {
            deps.stderr(`◼ borg representative reset-state: the state database (generation ${printable(report.previous ?? '')}) is healthy; nothing to reset.\n`);
            return 1;
        }
        const lines = [
            `Representative state reset: generation ${printable(report.previous ?? '')} replaced by ${printable(report.current ?? '')}.`,
            `The damaged generation is kept (not deleted) under the state directory: ${show(report.retainedAside) || 'none'}.`,
            `Bindings kept: ${report.salvaged.length ? show(report.salvaged) : 'none'}.`,
            ...report.dropped.map((drop) => `Binding lost${drop.worktree ? ` for ${printable(drop.worktree)}` : ''}: ${printable(drop.reason)}. ` +
                'Run `borg representative prepare` in that worktree to bind it again.'),
            'Lost: every delivery checkpoint (kept bindings replay their replies from the binding start: duplicates are possible, nothing is skipped),',
            'the request ledger (pending and ambiguous sends are no longer guarded: a send whose outcome was unknown may already be stored,',
            'and identical content is no longer blocked), and wake state (rebuilt by the listener).',
        ];
        deps.stdout(`${lines.join('\n')}\n`);
        return 0;
    }
    catch (error) {
        deps.stderr(`◼ borg representative reset-state: ${printable(describeError(error))}\n`);
        return 1;
    }
}
async function defaultReset() {
    const [{ resetRepresentativeState }, { parseBinding, bindingFingerprint: fingerprint }, { seatKey }] = await Promise.all([
        import('./representative-db.js'), import('./representative-store.js'), import('./representative-legacy.js'),
    ]);
    return resetRepresentativeState({
        validateBinding: (value, worktree) => parseBinding(value, worktree),
        generationOf: (binding) => fingerprint(binding),
        seatOf: (binding) => seatKey(binding),
    });
}
export async function runRepresentativeListen(command, deps, options = {}) {
    const { runListener } = await import('./representative-listener.js');
    return runListener(command, deps, options);
}
//# sourceMappingURL=representative-cmd.js.map