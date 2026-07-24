/**
 * Pure renderer for the `borg_roster` MCP tool output.
 *
 * Split out from `index.ts` so the T2.1 sender-side liveness probe
 * (the `awake`/`stale-since-X` column rendering when a `since` arg is
 * passed) can be unit-tested without spinning up the MCP server. Same
 * pure-function + injected-`humanAgo` pattern as `stream-status.ts`.
 *
 * Two modes:
 *   - No `since` provided: classic roster — one line per drone with
 *     label, role, and `last seen` relative time.
 *   - `since` provided: each line additionally carries an `awake`
 *     marker if the drone's `last_seen` is after the resolved
 *     timestamp, otherwise a `stale-since-<relative>` marker derived
 *     from the resolved timestamp the server echoed back.
 */

import { formatDroneAddressToken } from 'borgmcp-shared/drone-address';
import { escapeSyncDisplay } from './sync-roles-render.js';

export const RUNTIME_METADATA_ADVISORY =
  'Agent CLI, reported model, and working repository are advisory. They do not determine authority, role, health, activity, wake behavior, or routing.';

export interface RosterDrone {
  id?: string;
  label: string;
  role_id: string;
  last_seen: string | Date;
  /** Only present when the request carried `since`. */
  seen_since?: boolean;
  /**
   * gh#370 — which AI agent is running this drone. Null for drones that
   * joined before the column existed or via a launcher path that didn't
   * forward the kind. This is the agent CLI, not a model descriptor.
   */
  agent_kind?: 'claude' | 'codex' | 'opencode' | null;
  regen_count?: number | null;
  wake_path?: 'live' | 'degraded' | 'deaf' | null;
  wake_path_alert_class?:
    | 'dead'
    | 'post-blocked'
    | 'presumed-dead'
    | 'systemic-post-block'
    | 'wake-path-deaf'
    | 'independent'
    | null;
  /** Legacy launch descriptor retained on the wire for the Ollama launch path; not displayed. */
  model?: string | null;
  /** Advisory model string self-reported by the agent on regen. */
  reported_model?: string | null;
  /** Current cwd-derived repository identity, refreshed on regen. */
  working_repo_name?: string | null;
  working_repo_origin?: string | null;
  runtime_metadata_reported?: boolean;
}

export interface RosterRole {
  id: string;
  name: string;
  /**
   * Default model descriptor for drones assigned to this role.
   * Null = no role default (use cube default or null for Claude).
   */
  default_model?: string | null;
}

/**
 * gh#503 — render-layer display labels for the wake-path wire enum.
 *
 * The gh#406 SLI MEASURES a streak of unanswered directed challenges; it
 * cannot confirm a genuinely broken wake path ("deaf") — a seat that is
 * alive but idle-and-text-only looks identical past the SLA. So the
 * roster shows the measured-confidence label, not the unconfirmed verdict:
 *   degraded (1 miss)  → `unverified`   (signal seen, not yet corroborated)
 *   deaf     (2+ miss) → `unresponsive` (no response past the SLA)
 *
 * The wire enum VALUES (`live`/`degraded`/`deaf`), computed server-side by
 * `wakePathFromStreak`, are intentionally UNCHANGED — this is a display-only
 * relabel within gh#503's copy-only scope (renaming the enum would be a
 * wire + schema change). An operator who wants a confirmed read cross-checks
 * `borg_stream-status` on the affected seat. Unknown wire values fall back
 * to the raw value so a newer server can't break an older client's roster.
 */
const WAKE_PATH_DISPLAY: Record<string, string> = {
  degraded: 'unverified',
  deaf: 'unresponsive',
};

export function formatRoleAgentLabel(
  roleName: string,
  agentKind: RosterDrone['agent_kind']
): string {
  const agentCli = agentKind === 'claude'
    ? 'Claude Code'
    : agentKind === 'codex'
      ? 'Codex'
      : agentKind === 'opencode'
        ? 'OpenCode'
        : 'not reported';
  return `Role: ${roleName} · Agent CLI: ${agentCli}`;
}

export function formatWorkingRepoLabel(drone: Pick<RosterDrone, 'working_repo_name' | 'working_repo_origin'>): string {
  if (drone.working_repo_name && drone.working_repo_origin) {
    return `Working repo: ${drone.working_repo_name} · origin: ${drone.working_repo_origin}`;
  }
  if (drone.working_repo_name) return `Working repo: ${drone.working_repo_name}`;
  if (drone.working_repo_origin) return `Working repo: origin: ${drone.working_repo_origin}`;
  return 'Working repo: not reported';
}

function metadataValue(
  drone: RosterDrone,
  value: string | null | undefined,
): string {
  if (drone.runtime_metadata_reported !== true) return 'not reported';
  return value == null ? 'unknown' : escapeRuntimeMetadataDisplay(value);
}

/**
 * Keep accepted advisory metadata readable without letting a Markdown renderer
 * or link-detecting terminal turn cube-controlled text into a live target.
 * The visible `[.]` / `[:]` markers preserve the reported value's differences.
 */
export function escapeRuntimeMetadataDisplay(value: string): string {
  const escaped = escapeSyncDisplay(value);
  const defangedScheme = escaped.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*)\:\/\//g,
    '$1\\[:]//',
  );
  return defangedScheme.replace(
    /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}\b/g,
    (host) => host.replaceAll('.', '\\[.\\]'),
  );
}

export function renderRuntimeMetadataLines(
  drone: RosterDrone,
  opts: { includeOrigin?: boolean } = {},
): string[] {
  const agent = drone.agent_kind === 'claude'
    ? 'Claude Code'
    : drone.agent_kind === 'codex'
      ? 'Codex'
      : drone.agent_kind === 'opencode'
        ? 'OpenCode'
        : null;
  const lines = [
    `  - **Agent CLI:** ${metadataValue(drone, agent)}`,
    `  - **Reported model:** ${metadataValue(drone, drone.reported_model)}`,
    `  - **Working repo:** ${metadataValue(drone, drone.working_repo_name)}`,
  ];
  if (opts.includeOrigin) {
    const origin = drone.working_repo_origin?.replace(/^https:\/\//i, '');
    lines.push(`  - **Origin:** ${metadataValue(drone, origin)}`);
  }
  return lines;
}

export interface RenderRosterInputs {
  cubeName: string;
  drones: RosterDrone[];
  roles: RosterRole[];
  /**
   * Server-echoed resolved timestamp (ISO-8601). Present iff caller
   * passed `since` to `borg_roster`. Drives both the column header copy
   * AND the relative-time label on `stale-since-X` cells.
   */
  resolvedSince: string | null;
  /** Relative-time formatter, injected so the renderer is pure. */
  humanAgo: (d: Date | string) => string;
}

export function renderRoster(inputs: RenderRosterInputs): string {
  const { cubeName, drones, roles, resolvedSince, humanAgo } = inputs;
  const roleById = new Map<string, RosterRole>();
  for (const r of roles) roleById.set(r.id, r);

  const lines: string[] = [];
  lines.push(`# Drones in cube: ${cubeName}`);
  lines.push('');
  lines.push(`_${RUNTIME_METADATA_ADVISORY}_`);
  lines.push('');

  if (resolvedSince) {
    // Surface the liveness-probe context so the reader knows what the
    // `awake`/`stale-since-X` column is measured against.
    lines.push(
      `_Liveness probe since ${resolvedSince} (${humanAgo(
        resolvedSince
      )}). \`awake\` = drone posted to the cube log after that point._`
    );
    lines.push('');
  }

  if (!drones.length) {
    lines.push('_(no drones connected)_');
    return lines.join('\n');
  }

  for (const d of drones) {
    const role = roleById.get(d.role_id);
    const roleName = role?.name ?? 'unknown';
    // gh#371: stable short-uuid address token beside the (renumber-prone) label.
    const addr = d.id ? ` ${formatDroneAddressToken(d.id)}` : '';
    const lastSeen = humanAgo(d.last_seen);
    const wakePathMarker =
      d.wake_path && d.wake_path !== 'live'
        ? ` · \`wake-path:${WAKE_PATH_DISPLAY[d.wake_path] ?? d.wake_path}\``
        : '';
    const wakePathClassMarker =
      d.wake_path_alert_class && d.wake_path_alert_class !== 'independent'
        ? ` · \`wake-path-class:${d.wake_path_alert_class}\``
        : '';
    const regenCountMarker =
      typeof d.regen_count === 'number' ? ` · \`regen-count:${d.regen_count}\`` : '';
    if (resolvedSince) {
      // T2.1 awake/stale column. `seen_since === true` → drone called a
      // tool after the resolved timestamp; treat as awake. False or
      // missing → stale. Missing should not happen when the server
      // echoed a since, but defending against a shape mismatch is
      // cheap and matches the renderer's no-server-assumptions
      // discipline established in stream-status.ts.
      //
      // Per drone-4's polish NIT on the original T2.1 ship: the marker
      // is just `stale` (not `stale-since-<relative>`) because the
      // header already anchors the reference point and per-row "since
      // when" would be identical across all stale rows in a single
      // probe call — pure redundancy. The per-row `last seen X ago`
      // field carries the diagnostic detail for "how stale is this
      // particular drone."
      const isAwake = d.seen_since === true;
      const marker = isAwake ? '`awake`' : '`stale`';
      lines.push(
        `- **${d.label}**${addr} (Role: ${roleName}) — last seen ${lastSeen} · ${marker}${regenCountMarker}${wakePathMarker}${wakePathClassMarker}`
      );
    } else {
      lines.push(
        `- **${d.label}**${addr} (Role: ${roleName}) — last seen ${lastSeen}${regenCountMarker}${wakePathMarker}${wakePathClassMarker}`
      );
    }
    lines.push(...renderRuntimeMetadataLines(d, { includeOrigin: true }));
  }

  return lines.join('\n');
}
