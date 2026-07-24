/**
 * Tests for the `borg_roster` renderer per T2.1's sender-side liveness
 * column. Pure-function tests; no MCP server, no live worker — just
 * (drones, roles, since?) → markdown.
 *
 * The two modes:
 *   - No `since` → classic roster (preserved behavior).
 *   - `since` → each drone tagged `awake` or `stale-since-X`.
 */

import { describe, it, expect } from 'vitest';
import {
  renderRoster,
  type RosterDrone,
  type RosterRole,
} from '../src/roster-render';

const fakeHumanAgo = (d: Date | string) => {
  const date = typeof d === 'string' ? new Date(d) : d;
  // Deterministic synthetic relative time for assertions.
  const sec = Math.max(0, Math.round((1747000000000 - date.getTime()) / 1000));
  return `${sec}s ago`;
};

function roleSet(): RosterRole[] {
  return [
    { id: 'role-1', name: 'Coordinator' },
    { id: 'role-2', name: 'Builder' },
  ];
}

function drone(overrides: Partial<RosterDrone> & { label: string }): RosterDrone {
  return {
    id: 'drone-uuid',
    role_id: 'role-2',
    last_seen: '2026-05-11T18:00:00.000Z',
    agent_kind: null,
    reported_model: null,
    working_repo_name: null,
    working_repo_origin: null,
    runtime_metadata_reported: false,
    ...overrides,
  };
}

describe('renderRoster — classic mode (no since)', () => {
  it('emits one line per drone with label + role + last-seen', () => {
    const out = renderRoster({
      cubeName: 'my-cube',
      drones: [
        drone({ label: 'drone-1', role_id: 'role-1' }),
        drone({ label: 'drone-2', role_id: 'role-2' }),
      ],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('# Drones in cube: my-cube');
    expect(out).toMatch(/- \*\*drone-1\*\* `id:[^`]+` \(Role: Coordinator\) — last seen \d+s ago$/m);
    expect(out).toMatch(/- \*\*drone-2\*\* `id:[^`]+` \(Role: Builder\) — last seen \d+s ago$/m);
    expect(out.match(/\*\*Agent CLI:\*\* not reported/g)).toHaveLength(2);
    expect(out).not.toContain('awake');
    expect(out).not.toContain('stale-since');
    expect(out).not.toContain('Liveness probe');
  });

  it('renders regen_count when provided', () => {
    const out = renderRoster({
      cubeName: 'my-cube',
      drones: [drone({ label: 'drone-1', regen_count: 42 })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('`regen-count:42`');
  });

  it('renders the empty roster cleanly', () => {
    const out = renderRoster({
      cubeName: 'empty-cube',
      drones: [],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('_(no drones connected)_');
    expect(out).not.toContain('awake');
  });

  it('falls back to `unknown` when a drone references a missing role id', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'drone-x', role_id: 'role-missing' })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toMatch(/\*\*drone-x\*\* `id:[^`]+` \(Role: unknown\)/);
  });
});

describe('renderRoster — liveness mode (since provided)', () => {
  const SINCE = '2026-05-11T18:00:00.000Z';

  it('marks drones with seen_since=true as `awake`', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({
          label: 'drone-fresh',
          role_id: 'role-2',
          last_seen: '2026-05-11T18:05:00.000Z',
          seen_since: true,
        }),
      ],
      roles: roleSet(),
      resolvedSince: SINCE,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('`awake`');
    expect(out).not.toContain('stale-since');
    expect(out).toContain('Liveness probe since');
  });

  // Helper: extract only the per-drone bullet lines so assertions don't
  // catch the `awake`/`stale-since-X` glossary words in the header.
  const droneLines = (out: string) =>
    out.split('\n').filter((l) => l.startsWith('- '));

  it('marks drones with seen_since=false as `stale` (no redundant since-X)', () => {
    // Per drone-4's polish NIT: the per-row marker is just `stale` —
    // the header already anchors the reference point and per-row
    // "since when" would be identical across all stale rows.
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({
          label: 'drone-stale',
          role_id: 'role-2',
          last_seen: '2026-05-11T17:00:00.000Z',
          seen_since: false,
        }),
      ],
      roles: roleSet(),
      resolvedSince: SINCE,
      humanAgo: fakeHumanAgo,
    });
    const bullets = droneLines(out).join('\n');
    expect(bullets).toContain('`stale`');
    expect(bullets).not.toMatch(/stale-since/);
    expect(bullets).not.toContain('`awake`');
  });

  it('handles a mixed roster — each drone gets its own marker', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({ label: 'drone-a', seen_since: true }),
        drone({ label: 'drone-b', seen_since: false }),
        drone({ label: 'drone-c', seen_since: true }),
      ],
      roles: roleSet(),
      resolvedSince: SINCE,
      humanAgo: fakeHumanAgo,
    });
    const bullets = droneLines(out).join('\n');
    expect(bullets.match(/`awake`/g)).toHaveLength(2);
    expect(bullets.match(/`stale`/g)).toHaveLength(1);
    expect(bullets).not.toMatch(/stale-since/);
  });

  it('treats missing seen_since (shape mismatch) as stale — defensive default', () => {
    // If the server omits seen_since unexpectedly, the renderer should
    // not silently surface those drones as awake — that would be the
    // false-positive failure mode of the whole probe.
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'drone-shape', /* no seen_since */ })],
      roles: roleSet(),
      resolvedSince: SINCE,
      humanAgo: fakeHumanAgo,
    });
    const bullets = droneLines(out).join('\n');
    expect(bullets).toContain('`stale`');
    expect(bullets).not.toContain('`awake`');
  });

  it('emits the liveness-probe context line so readers know the reference point', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'drone-a', seen_since: true })],
      roles: roleSet(),
      resolvedSince: SINCE,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain(`Liveness probe since ${SINCE}`);
    expect(out).toContain('`awake` = drone posted to the cube log after that point');
  });
});

describe('renderRoster — distinct agent CLI and model fields', () => {
  it('labels Claude Code as the agent CLI when agent_kind=claude', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd1', role_id: 'role-2', agent_kind: 'claude', runtime_metadata_reported: true })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Agent CLI:** Claude Code');
  });

  it('labels Codex as the agent CLI when agent_kind=codex', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd2', role_id: 'role-2', agent_kind: 'codex', runtime_metadata_reported: true })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Agent CLI:** Codex');
  });

  it('labels OpenCode as the agent CLI when agent_kind=opencode', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd-open', agent_kind: 'opencode', runtime_metadata_reported: true })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Agent CLI:** OpenCode');
  });

  it('reports an unreported agent CLI when agent_kind is null (legacy drone)', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd3', role_id: 'role-2', agent_kind: null })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Agent CLI:** not reported');
  });

  it('reports an unreported agent CLI when agent_kind is absent from the wire shape', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd4', role_id: 'role-2' })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Agent CLI:** not reported');
  });

  it('combines with the liveness-probe `awake`/`stale` column when both are present', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({ label: 'd5', role_id: 'role-2', agent_kind: 'claude', runtime_metadata_reported: true, seen_since: true }),
        drone({ label: 'd6', role_id: 'role-2', agent_kind: 'codex', runtime_metadata_reported: true, seen_since: false }),
      ],
      roles: roleSet(),
      resolvedSince: '2026-05-11T18:00:00.000Z',
      humanAgo: fakeHumanAgo,
    });
    expect(out).toMatch(/- \*\*d5\*\* `id:[^`]+` \(Role: Builder\) .* `awake`/);
    expect(out).toMatch(/- \*\*d6\*\* `id:[^`]+` \(Role: Builder\) .* `stale`/);
    expect(out).toContain('**Agent CLI:** Claude Code');
    expect(out).toContain('**Agent CLI:** Codex');
  });

});

describe('renderRoster — self-reported metadata', () => {
  it('renders advisory reported model and working repository while hiding the legacy configured descriptor', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({
        label: 'd-self-report',
        model: 'claude:claude-opus-4-8',
        reported_model: 'gpt-5',
        working_repo_name: 'borgmcp/borg-mcp',
        working_repo_origin: 'https://github.com/borgmcp/borg-mcp',
        runtime_metadata_reported: true,
      })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });

    expect(out).toContain('**Reported model:** gpt-5');
    expect(out).toContain('**Working repo:** borgmcp/borg-mcp');
    expect(out).toContain('**Origin:** https://github.com/borgmcp/borg-mcp');
    expect(out).not.toContain('Configured model:');
  });

  it('does not disclose a directory when a drone has no repository identity', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd-non-git' })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });

    expect(out).toContain('**Working repo:** not reported');
    expect(out).not.toContain('/tmp/scratch-project');
  });

  it('renders explicit unknown distinctly from an unreported older seat', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({ label: 'known-unknown', runtime_metadata_reported: true }),
        drone({ label: 'not-reported' }),
      ],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out.match(/\*\*Agent CLI:\*\* unknown/g)).toHaveLength(1);
    expect(out.match(/\*\*Agent CLI:\*\* not reported/g)).toHaveLength(1);
  });

  it('preserves maximum accepted values without truncation and escapes hostile controls defensively', () => {
    const model = `m${'x'.repeat(159)}`;
    const repo = `${'o'.repeat(100)}/${'r'.repeat(100)}`;
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({
        label: 'boundary',
        runtime_metadata_reported: true,
        agent_kind: 'claude',
        reported_model: model,
        working_repo_name: repo,
        working_repo_origin: 'safe\u001b[2J\u061c',
      })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain(model);
    expect(out).toContain(repo);
    expect(out).not.toContain('…');
    expect(out).toContain('\\u{1b}');
    expect(out).toContain('\\u{61c}');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u061c');
  });
});

describe('renderRoster — gh#406 wake_path marker', () => {
  it('omits the wake-path marker for live or missing values', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({ label: 'live-drone', wake_path: 'live' }),
        drone({ label: 'legacy-drone' }),
      ],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).not.toContain('wake-path:live');
    expect(out).not.toContain('wake-path:unverified');
    expect(out).not.toContain('wake-path:unresponsive');
  });

  // gh#503: the wire enum (degraded/deaf) is fed in unchanged, but the
  // roster DISPLAYS the measured-confidence labels (unverified/unresponsive)
  // — the SLI measures unanswered challenges, it cannot confirm "deaf".
  it('renders the unverified/unresponsive display labels for degraded/deaf states', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({ label: 'd1', wake_path: 'degraded' }),
        drone({ label: 'd2', wake_path: 'deaf', seen_since: false }),
      ],
      roles: roleSet(),
      resolvedSince: '2026-05-11T18:00:00.000Z',
      humanAgo: fakeHumanAgo,
    });
    // Display labels are present...
    expect(out).toContain('`wake-path:unverified`');
    expect(out).toContain('`wake-path:unresponsive`');
    // ...and the raw wire-enum verdict terms never leak into the marker.
    expect(out).not.toContain('wake-path:degraded');
    expect(out).not.toContain('wake-path:deaf');
  });

  it('renders wake-path alert class alongside the wake-path marker', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [
        drone({
          label: 'd1',
          wake_path: 'deaf',
          wake_path_alert_class: 'post-blocked',
        }),
        drone({
          label: 'd2',
          wake_path_alert_class: 'independent',
        }),
      ],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });

    expect(out).toContain('`wake-path:unresponsive`');
    expect(out).toContain('`wake-path-class:post-blocked`');
    expect(out).not.toContain('wake-path-class:independent');
  });
});

describe('renderRoster — legacy configured model suppression', () => {
  it('does not render the legacy launch descriptor even when present on the wire', () => {
    const out = renderRoster({
      cubeName: 'c',
      drones: [drone({ label: 'd1', role_id: 'role-2', model: 'claude:claude-opus-4-8' })],
      roles: roleSet(),
      resolvedSince: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('**Reported model:** not reported');
    expect(out).not.toContain('Configured model:');
  });
});
