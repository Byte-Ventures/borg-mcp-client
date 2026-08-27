import type { MessageTaxonomy } from 'borgmcp-shared/templates';
import { formatLogEntryMarkdown } from './regen-format.js';

// Small backlogs remain verbatim so normal wake triage is unchanged.
export const DIGEST_THRESHOLD = 50;
// The latest decisions stay in full while older activity is summarized.
export const DIGEST_TAIL = 25;
// One reattach cannot consume an unbounded amount of local memory or output.
export const DIGEST_FETCH_CAP = 2000;

interface ReadLogDigestInput {
  entries: any[];
  selfDroneId: string;
  taxonomy: MessageTaxonomy | null | undefined;
  droneById: Map<string, any>;
  roleById: Map<string, any>;
  tail: number;
  capped: number;
}

export interface ReadLogDigest {
  text: string;
  tailEntries: any[];
  omitted: number;
}

function senderLabel(
  entry: any,
  droneById: Map<string, any>,
  roleById: Map<string, any>,
): string {
  const drone = droneById.get(entry.drone_id);
  const role = drone ? roleById.get(drone.role_id) : undefined;
  const label = drone?.label ?? entry.drone_label ?? '?';
  const roleName = role?.name ?? entry.role_name ?? '?';
  return `${label} (${roleName})`;
}

function messageClass(message: unknown, taxonomy: MessageTaxonomy | null | undefined): string {
  if (typeof message !== 'string') return 'other';
  for (const classDef of taxonomy ?? []) {
    if (classDef.prefixes?.some((prefix) => message.startsWith(prefix))) return classDef.class;
  }
  return 'other';
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function buildReadLogDigest(input: ReadLogDigestInput): ReadLogDigest {
  const tailEntries = input.entries.slice(-input.tail);
  const omitted = input.entries.length - tailEntries.length;
  const oldest = new Date(input.entries[0].created_at).toISOString();
  const newest = new Date(input.entries[input.entries.length - 1].created_at).toISOString();
  const senderCounts = new Map<string, number>();
  const classCounts = new Map<string, number>();

  for (const entry of input.entries) {
    increment(senderCounts, senderLabel(entry, input.droneById, input.roleById));
    increment(classCounts, messageClass(entry.message, input.taxonomy));
  }

  const lines = [
    `Reattach digest — ${input.entries.length} unread entries from ${oldest} to ${newest}; ${omitted} older entries are summarized, not shown. Older directed entries may be superseded: confirm with the sender or borg_read-entry before acting.`,
  ];
  if (input.capped > 0) {
    lines.push(`${input.capped} additional unread ${input.capped === 1 ? 'entry was' : 'entries were'} not covered because the ${DIGEST_FETCH_CAP}-entry fetch cap was reached.`);
  }

  lines.push('', '## Counts by sender');
  for (const [sender, count] of senderCounts) lines.push(`- ${sender}: ${count}`);
  lines.push('', '## Counts by message class');
  for (const [className, count] of classCounts) lines.push(`- ${className}: ${count}`);

  const directed = input.entries.slice(0, omitted).filter((entry) =>
    entry.visibility === 'direct' &&
    Array.isArray(entry.recipient_drone_ids) &&
    entry.recipient_drone_ids.includes(input.selfDroneId)
  );
  if (directed.length > 0) {
    lines.push('', '## Older entries directed to this seat');
    for (const entry of directed) {
      const ts = new Date(entry.created_at).toISOString();
      const message = typeof entry.message === 'string'
        ? entry.message.replace(/\s+/g, ' ').slice(0, 120)
        : '';
      lines.push(`[${ts}] [entry_id: ${entry.id}] ${senderLabel(entry, input.droneById, input.roleById)}: ${message}`);
    }
  }

  lines.push('', `## Newest ${tailEntries.length} entries`);
  for (const entry of tailEntries) {
    lines.push(formatLogEntryMarkdown(entry, input.droneById, input.roleById));
  }

  return { text: lines.join('\n'), tailEntries, omitted };
}
