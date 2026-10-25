import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { constants, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { openSync } from './guarded-fs.js';
import path from 'node:path';
import { fs } from './guarded-fs.js';
import { isCanonicalPath } from './private-root.js';
import { openCodePrivateRoot, ensureOpenCodePrivateRoot, verifyOpenCodePrivateWindowsPath, sameOpenCodeDirectory } from './opencode-private-state.js';
import { LOG_AUDIT_NUDGE } from './log-audit-core.js';
export const OPENCODE_V2_DESCRIPTOR_ENV = 'BORG_OPENCODE_V2_DESCRIPTOR';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const sameSeat = (a, b) => a.cubeId === b.cubeId && a.droneId === b.droneId && a.worktree === b.worktree;
/** Use an opened fd for validation and reading; refuse path substitution/symlinks. */
export function readOpenCodeV2Descriptor(filename) {
    if (!isCanonicalPath(filename) || realpathSync(filename) !== filename)
        throw new Error('OpenCode 2 launch descriptor is not canonical.');
    const parent = path.dirname(filename);
    verifyOpenCodePrivateWindowsPath(parent);
    verifyOpenCodePrivateWindowsPath(filename);
    const dir = fs.lstatSync(parent);
    const fd = openSync(filename, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0));
    try {
        const stat = fstatSync(fd);
        const uid = process.platform === 'win32' ? undefined : process.getuid?.();
        if (!dir.isDirectory() || !stat.isFile() || stat.size > 16_384 ||
            (uid !== undefined && (dir.uid !== uid || stat.uid !== uid)) ||
            (process.platform !== 'win32' && ((dir.mode & 0o777) !== 0o700 || (stat.mode & 0o777) !== 0o600))) {
            throw new Error('OpenCode 2 launch descriptor is not private.');
        }
        const data = JSON.parse(readFileSync(fd, 'utf8'));
        const endpoint = new URL(data.url);
        if (data.generation !== 2 || !/^[\w-]{43}$/.test(data.capability) || !/^[\w-]{43}$/.test(data.launch) ||
            endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
            endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
            !data.sessionID?.startsWith('ses_') || !data.seat || !isCanonicalPath(data.seat.worktree) ||
            typeof data.seat.droneId !== 'string' || typeof data.seat.cubeId !== 'string' ||
            !Number.isInteger(data.server?.pid) || typeof data.server.version !== 'string') {
            throw new Error('OpenCode 2 launch descriptor is invalid.');
        }
        return data;
    }
    finally {
        closeSync(fd);
    }
}
/** Claims outlive launches so --continue cannot take another drone's session. */
export function claimOpenCodeV2Session(sessionID, seat, root = openCodePrivateRoot()) {
    if (!isCanonicalPath(root))
        throw new Error('OpenCode private state path is unsafe.');
    ensureOpenCodePrivateRoot(root);
    const filename = path.join(root, `opencode-v2-owner-${digest(sessionID)}.json`);
    const expected = JSON.stringify({ generation: 2, sessionID, seat });
    try {
        fs.writeFileSync(filename, expected, { flag: 'wx', mode: 0o600 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        if (!isCanonicalPath(filename))
            throw new Error('OpenCode session ownership path is unsafe.');
        const metadata = fs.lstatSync(filename);
        if (!metadata.isFile() || (process.getuid && metadata.uid !== process.getuid()) ||
            (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0))
            throw new Error('OpenCode ownership record is not private.');
        const existing = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (existing.sessionID !== sessionID || !sameSeat(existing.seat, seat)) {
            throw new Error('This OpenCode session belongs to another Borg drone or worktree.');
        }
    }
}
export async function startOpenCodeV2Broker(options) {
    const root = options.root ?? openCodePrivateRoot();
    ensureOpenCodePrivateRoot(root);
    claimOpenCodeV2Session(options.sessionID, options.seat, root);
    const launch = options.launch ?? randomBytes(32).toString('base64url');
    if (!/^[\w-]{43}$/.test(launch))
        throw new Error('Invalid OpenCode launch identity');
    const capability = randomBytes(32).toString('base64url');
    const pluginCapability = randomBytes(32).toString('base64url');
    const descriptorPath = path.join(root, `opencode-v2-${launch}.json`);
    const pluginDescriptorPath = `${descriptorPath}.plugin`;
    const journalPath = path.join(root, `opencode-v2-${launch}.journal.json`);
    let sessionID = options.sessionID;
    let pluginReady = false;
    let tools = [];
    let humanHandoff = null;
    let revoked = false;
    const deliveries = new Map();
    const audits = new Map();
    let serial = Promise.resolve();
    const persist = () => {
        const temp = `${journalPath}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ generation: 2, launch, server: options.server,
            seat: options.seat, sessionID, deliveries: [...deliveries], audits: [...audits] }), { mode: 0o600 });
        fs.renameSync(temp, journalPath);
    };
    const verifySession = async (id) => {
        const session = await options.transport.client.session.get({ sessionID: id });
        if (session.parentID || !sameOpenCodeDirectory(session.location.directory, options.seat.worktree)) {
            throw new Error('OpenCode session is not a human session in this drone worktree.');
        }
        claimOpenCodeV2Session(id, options.seat, root);
        return session;
    };
    const reconcile = async (delivery) => {
        if (delivery.settled || delivery.delivered)
            return;
        const message = await options.transport.message(delivery.sessionID, delivery.id);
        if (message?.role === 'user' && message.metadata.borgOpenCodeWakeIdentity === delivery.id) {
            delivery.admitted = true;
            delivery.delivered = true;
            persist();
            return;
        }
        const inbox = await options.transport.client.session.inbox.list({ sessionID: delivery.sessionID });
        if (inbox.some((item) => item.id === delivery.id)) {
            delivery.admitted = true;
            persist();
        }
    };
    const submit = async (delivery, resume) => {
        await reconcile(delivery);
        if (delivery.admitted || delivery.delivered || delivery.settled)
            return;
        // Intent (including the native ascending ID) is durable before admission.
        persist();
        try {
            await options.transport.client.session.prompt({ sessionID: delivery.sessionID, id: delivery.id,
                text: delivery.text, metadata: { borgOpenCodeInjectedEntry: true, borgOpenCodeWakeIdentity: delivery.id },
                delivery: 'steer', ...(resume === false ? { resume: false } : {}),
            });
            delivery.admitted = true;
            persist();
        }
        catch {
            await reconcile(delivery);
        }
    };
    const nudge = (id) => (audits.get(id)?.material ?? 0) >= 3 ? LOG_AUDIT_NUDGE(audits.get(id).material) : '';
    const resolveHandoff = async () => {
        const handoff = humanHandoff;
        if (!handoff)
            return;
        const message = await options.transport.message(handoff.sessionID, handoff.messageID);
        if (!message || message.role !== 'user' || message.metadata.borgOpenCodeInjectedEntry === true)
            return;
        await verifySession(handoff.sessionID);
        sessionID = handoff.sessionID;
        humanHandoff = null;
        persist();
    };
    const material = new Set(['shell', 'bash', 'edit', 'write', 'apply_patch', 'exec_command', 'multiedit', 'notebookedit']);
    const materialName = (name) => String(name).split('.').at(-1).toLowerCase();
    const dispatch = async (operation, body) => {
        if (revoked)
            throw new Error('Launch revoked');
        if (operation === '/bind') {
            if (!sameSeat(body.seat, options.seat))
                throw new Error('Seat mismatch');
            await verifySession(sessionID);
            return { sessionID, generation: 2, launch, pluginReady };
        }
        if (operation === '/ready') {
            pluginReady = true;
            return { ok: true };
        }
        if (operation === '/unready') {
            pluginReady = false;
            tools = [];
            return { ok: true };
        }
        if (operation === '/mcp-options')
            return options.mcpOptions ?? {};
        if (operation === '/catalog') {
            if (!Array.isArray(body.tools) || body.tools.length > 512 || body.tools.some((id) => typeof id !== 'string' || !id.startsWith('borg_')))
                throw new Error('Invalid Borg catalog');
            tools = body.tools;
            return { ok: true };
        }
        if (operation === '/human') {
            // Only the launch-specific plugin may propose a session observed by its
            // human prompt hook. A root in another worktree or a native child fails.
            await verifySession(body.sessionID);
            if (typeof body.messageID !== 'string' || !body.messageID.startsWith('msg_'))
                throw new Error('Invalid human message');
            humanHandoff = { sessionID: body.sessionID, messageID: body.messageID };
            return { sessionID };
        }
        if (operation === '/audit' || operation === '/audit-begin') {
            if (body.sessionID !== sessionID)
                return { nudge: '' };
            const audit = audits.get(sessionID) ?? { seen: [], material: 0, epoch: 0, executions: {} };
            const execution = `${body.messageID}:${body.id}`;
            if (typeof body.id !== 'string' || typeof body.messageID !== 'string')
                throw new Error('Invalid runtime execution');
            const group = audit.executions[execution] ??= { active: false, observed: {}, reset: {}, contribution: 0, epoch: audit.epoch };
            if (operation === '/audit-begin')
                group.active = true;
            else if (body.tool === 'execute') {
                if (!audit.seen.includes(`${execution}:codemode`) && (Array.isArray(body.operations) || body.status === 'error')) {
                    // The published native host reuses the outer call ID for nested
                    // execute hooks. Its structured runtime rows supply stable nested
                    // positions; counting only hook IDs collapses a whole script to one.
                    const totals = {};
                    for (const row of body.operations ?? []) {
                        const name = materialName(row?.tool);
                        if (row?.status === 'completed' && material.has(name))
                            totals[name] = (totals[name] ?? 0) + 1;
                    }
                    if (!Array.isArray(body.operations))
                        Object.assign(totals, group.observed);
                    const count = Object.entries(totals).reduce((sum, [name, total]) => sum + Math.max(0, total - (group.reset[name] ?? 0)), 0);
                    audit.material += count - (group.epoch === audit.epoch ? group.contribution : 0);
                    group.contribution = count;
                    group.epoch = audit.epoch;
                    audit.seen.push(`${execution}:codemode`);
                }
                group.active = false;
            }
            else {
                const name = materialName(body.tool);
                if (!audit.seen.includes(`${execution}:codemode`) && body.status === 'completed' && material.has(name)) {
                    if (group.active)
                        group.observed[name] = (group.observed[name] ?? 0) + 1;
                    else if (!audit.seen.includes(`${execution}:direct`)) {
                        audit.seen.push(`${execution}:direct`);
                        audit.material++;
                        group.contribution = 1;
                        group.epoch = audit.epoch;
                    }
                }
            }
            audits.set(sessionID, audit);
            persist();
            return { nudge: nudge(sessionID) };
        }
        if (operation === '/logged') {
            if (body.sessionID !== sessionID)
                return { ok: false };
            const audit = audits.get(sessionID);
            if (audit) {
                audit.material = 0;
                audit.epoch++;
                // A persisted log inside a Code Mode script resets earlier completed
                // operations too. The final outer result must not count them again.
                for (const group of Object.values(audit.executions))
                    if (group.active)
                        group.reset = { ...group.observed };
                persist();
            }
            return { ok: true };
        }
        if (operation === '/context') {
            await resolveHandoff();
            if (body.sessionID !== sessionID)
                return { text: '' };
            await verifySession(sessionID);
            return { text: `${await options.orientation()}\n\n${nudge(sessionID)}` };
        }
        if (operation === '/settle') {
            for (const delivery of deliveries.values())
                if (delivery.source === body.source)
                    delivery.settled = true;
            persist();
            return { ok: true };
        }
        if (operation === '/wake') {
            await resolveHandoff();
            await verifySession(sessionID);
            if (body.key !== 'readiness' && options.seat.droneId !== 'unassimilated' &&
                body.allowSubmit !== false && (!pluginReady || tools.length === 0))
                return { accepted: false };
            if (typeof body.text !== 'string' || !body.text.trim() || typeof body.key !== 'string')
                throw new Error('Invalid wake');
            let delivery = deliveries.get(body.key);
            if (!delivery) {
                if (body.allowSubmit === false)
                    return { accepted: false };
                delivery = { id: options.transport.nextMessageID(), sessionID, text: body.text,
                    source: typeof body.source === 'string' ? body.source : body.key, admitted: false, delivered: false, settled: false };
                deliveries.set(body.key, delivery);
                persist();
            }
            if (body.allowSubmit === false)
                await reconcile(delivery);
            else
                await submit(delivery, body.key === 'readiness' ? false : body.resume);
            return { accepted: delivery.admitted || delivery.delivered, delivered: delivery.delivered, settled: delivery.settled, id: delivery.id };
        }
        if (operation === '/status') {
            await resolveHandoff();
            await verifySession(sessionID);
            return { sessionID, pluginReady, tools, pending: [...deliveries.values()].filter((d) => !d.delivered && !d.settled).length };
        }
        throw new Error('Unsupported broker operation');
    };
    const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const auth = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${capability}`);
        const pluginExpected = Buffer.from(`Bearer ${pluginCapability}`);
        const authenticated = auth.length === expected.length && timingSafeEqual(auth, expected);
        const authenticatedPlugin = auth.length === pluginExpected.length && timingSafeEqual(auth, pluginExpected);
        const pluginOperations = ['/human', '/ready', '/unready', '/catalog', '/mcp-options', '/audit-begin', '/audit'];
        if (req.method !== 'POST' || req.headers.origin || (!authenticated && !authenticatedPlugin) ||
            (pluginOperations.includes(req.url ?? '') && !authenticatedPlugin)) {
            res.writeHead(403).end('{}');
            return;
        }
        try {
            let input = '';
            for await (const chunk of req) {
                input += chunk;
                if (Buffer.byteLength(input) > 262_144)
                    throw new Error('Too large');
            }
            const body = JSON.parse(input);
            if (body.launch !== launch)
                throw new Error('Launch mismatch');
            // Serialize admission, handoff, and audit updates across MCP reconnects.
            const operation = req.url ?? '';
            // Native prompt admission calls plugin hooks before returning. Hook
            // callbacks must be reentrant; putting them behind that same admission
            // promise would deadlock the host. Only wake admissions need the queue.
            const task = operation === '/wake' ? serial.then(() => dispatch(operation, body)) : dispatch(operation, body);
            if (operation === '/wake')
                serial = task.then(() => { }, () => { });
            res.end(JSON.stringify(await task));
        }
        catch {
            res.writeHead(409).end('{"error":"OpenCode 2 launch binding or operation could not be verified"}');
        }
    });
    server.requestTimeout = 15_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Broker did not bind loopback');
    const descriptor = { generation: 2, launch, capability, seat: options.seat,
        sessionID, server: options.server, url: `http://127.0.0.1:${address.port}` };
    const pluginDescriptor = { ...descriptor, capability: pluginCapability };
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(pluginDescriptorPath, JSON.stringify(pluginDescriptor), { flag: 'wx', mode: 0o600 });
    persist();
    const timer = setInterval(() => {
        const task = serial.then(async () => {
            for (const delivery of deliveries.values())
                if (!delivery.delivered && !delivery.settled) {
                    try {
                        await reconcile(delivery);
                    }
                    catch { /* Durable journal remains available on reconnect. */ }
                }
        });
        serial = task.catch(() => { });
    }, 3_000);
    timer.unref();
    return { descriptorPath, descriptor,
        selectSession: async (id) => {
            await verifySession(id);
            sessionID = id;
            descriptor.sessionID = id;
            pluginDescriptor.sessionID = id;
            const temp = `${descriptorPath}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(descriptor), { mode: 0o600 });
            fs.renameSync(temp, descriptorPath);
            fs.writeFileSync(temp, JSON.stringify(pluginDescriptor), { mode: 0o600 });
            fs.renameSync(temp, pluginDescriptorPath);
            persist();
        },
        call: (operation, body = {}) => callOpenCodeV2Broker(['/human', '/ready', '/unready', '/catalog', '/mcp-options', '/audit-begin', '/audit'].includes(operation) ? pluginDescriptor : descriptor, operation, body),
        async close() {
            revoked = true;
            clearInterval(timer);
            server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
            fs.rmSync(descriptorPath, { force: true });
            fs.rmSync(pluginDescriptorPath, { force: true });
            // The credential-free journal is useful for diagnosis; no replay into a
            // new private server is attempted after the owning launcher has exited.
        },
    };
}
export async function callOpenCodeV2Broker(descriptor, operation, body = {}) {
    const response = await fetch(`${descriptor.url}${operation}`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${descriptor.capability}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, launch: descriptor.launch }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok)
        throw new Error('OpenCode 2 launch broker refused the operation. Relaunch through borg.');
    return response.json();
}
//# sourceMappingURL=opencode-v2-broker.js.map