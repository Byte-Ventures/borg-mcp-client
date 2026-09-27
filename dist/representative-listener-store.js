/** Bounded private listener tail and crash-recoverable hint metadata. */
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { borgConfigRoot, borgHomeRoot } from './private-root.js';
import { assertSecureRoot, atomicWrite0600, readStoreFile } from './seat-store.js';
import { formatInboxLine, inboxRawHasEntry, INBOX_TAIL_LINES_CAP, INBOX_TAIL_TRIM_THRESHOLD_LINES } from './log-stream.js';
import { isRepresentativeUuid } from './representative-store.js';
const empty = () => ({ version: 1, watermark: null, resumeReset: false, hints: {} });
export function listenerPaths(binding) {
    const key = createHash('sha256').update(JSON.stringify([binding.worktree, binding.origin, binding.trustIdentity,
        binding.cubeId, binding.representativeDroneId, binding.coordinatorDroneId, binding.boundAt])).digest('hex');
    const directory = join(borgConfigRoot(), 'representative-inboxes', key);
    return { directory, inbox: join(directory, 'inbox.log'), state: join(directory, 'stream.json') };
}
function requestId(message) {
    return /\brequest_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/i.exec(message)?.[1] ?? null;
}
function parseLine(line) {
    const match = /^(\S+) (.*?) \((.*?)\): \[entry_id: ([0-9a-f-]+)\] (.*)$/i.exec(line);
    if (!match || !isRepresentativeUuid(match[4]) || !Number.isFinite(Date.parse(match[1])))
        throw new Error('Invalid representative inbox line');
    return { id: match[4], created_at: match[1], label: match[2], role: match[3], message: match[5] };
}
function newer(a, b) {
    return b === null || a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);
}
export function createListenerInbox(binding, guard = async () => { }) {
    const paths = listenerPaths(binding);
    const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
    // Reuse the store's policy for every ancestor; never repair unsafe state.
    const validate = async (create) => {
        let current = borgHomeRoot();
        for (const component of relative(current, paths.directory).split(sep)) {
            if (!await assertSecureRoot(current, current === borgConfigRoot() || current.startsWith(borgConfigRoot() + sep) ? 'private' : 'owner-controlled', create))
                return false;
            current = join(current, component);
        }
        return assertSecureRoot(current, 'private', create);
    };
    const load = async () => {
        if (!await validate(false))
            return { state: empty(), lines: [] };
        const raw = await readStoreFile(paths.inbox, options) ?? '';
        const saved = await readStoreFile(paths.state, options);
        let state = empty();
        if (saved !== null) {
            // Lost/corrupt metadata cannot suppress surviving inbox lines on replay.
            // The secure read itself still fails closed on ownership/path/identity drift.
            try {
                const parsed = JSON.parse(saved);
                if (parsed.version === 1 && typeof parsed.resumeReset === 'boolean' && parsed.hints && typeof parsed.hints === 'object' &&
                    (parsed.watermark === null || (isRepresentativeUuid(parsed.watermark?.id) && Number.isFinite(Date.parse(parsed.watermark?.created_at)))))
                    state = parsed;
            }
            catch { /* recover the watermark and nullable replay metadata from the tail */ }
        }
        const lines = raw.split('\n').filter(Boolean);
        for (const line of lines) {
            const point = parseLine(line);
            if (newer(point, state.watermark)) {
                state.watermark = { id: point.id, created_at: point.created_at };
                state.resumeReset = false;
            }
        }
        return { state, lines };
    };
    const write = async (file, raw) => {
        await guard();
        await validate(true);
        await atomicWrite0600(file, raw, options);
    };
    const hint = (line, state, replay) => {
        const parsed = parseLine(line), metadata = state.hints[parsed.id];
        return { event: 'entry', entry_id: parsed.id, created_at: parsed.created_at,
            from_label: parsed.label, from_role: parsed.role, request_id: requestId(parsed.message), replay,
            visibility: metadata?.visibility === 'direct' || metadata?.visibility === 'broadcast' ? metadata.visibility : null,
            documents: Number.isInteger(metadata?.documents) && metadata.documents >= 0 ? metadata.documents : null };
    };
    return {
        paths,
        snapshot: async () => { const { state } = await load(); return { watermark: state.watermark?.id ?? null, inbox: paths.inbox }; },
        dedupeCursor: async () => (await load()).state.watermark,
        cursor: async () => { const { state } = await load(); return state.resumeReset ? null : state.watermark; },
        clearCursor: async () => { const { state } = await load(); state.resumeReset = true; await write(paths.state, JSON.stringify(state)); },
        replay: async (after) => {
            const { state, lines } = await load();
            const index = lines.findIndex(line => parseLine(line).id === after);
            return { missing: index < 0, hints: lines.slice(index + 1).map(line => hint(line, state, true)) };
        },
        append: async (entry, catchupCursor = null) => {
            if (!isRepresentativeUuid(entry.id) || !Number.isFinite(Date.parse(entry.created_at)) ||
                !['direct', 'broadcast'].includes(entry.visibility))
                throw new Error('Invalid representative stream entry');
            const { state, lines } = await load();
            const line = formatInboxLine(entry);
            if (lines.some(value => parseLine(value).id === entry.id && inboxRawHasEntry(value, entry.id, line)) ||
                (catchupCursor !== null && !newer(entry, catchupCursor)))
                return null;
            state.hints[entry.id] = { visibility: entry.visibility, documents: entry.documents?.length ?? 0 };
            // Metadata first, then atomic inbox publication, then watermark/metadata trim.
            // A crash after publication recovers its watermark from the surviving tail.
            await write(paths.state, JSON.stringify(state));
            lines.push(line);
            const kept = lines.length > INBOX_TAIL_TRIM_THRESHOLD_LINES ? lines.slice(-INBOX_TAIL_LINES_CAP) : lines;
            await write(paths.inbox, kept.join('\n') + '\n');
            if (newer(entry, state.watermark))
                state.watermark = { id: entry.id, created_at: entry.created_at };
            state.resumeReset = false;
            state.hints = Object.fromEntries(kept.map(value => parseLine(value).id).filter(id => state.hints[id]).map(id => [id, state.hints[id]]));
            await write(paths.state, JSON.stringify(state));
            // Linear scans/rewrites are deliberately bounded to 1025 lines; a larger
            // retention policy would need an indexed journal instead of this tail.
            return hint(line, state, false);
        },
    };
}
//# sourceMappingURL=representative-listener-store.js.map