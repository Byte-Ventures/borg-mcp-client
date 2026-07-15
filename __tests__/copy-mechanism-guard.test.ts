/**
 * gh#490 — copy↔mechanism CI guard. (Layer 2 self-enforcing upgrade: gh#529.)
 *
 * User-facing copy that names a `borg_` tool (regen tips, playbook text, error
 * remediation) must reference a tool that actually EXISTS, and any parameter it
 * tells the user to pass must actually be EXPOSED by that tool's inputSchema.
 *
 * The #479 miss is the motivating class: the regen tip recommended
 * "Use `borg_update-cube` with a taxonomy array" while the client tool's
 * inputSchema did NOT expose `message_taxonomy` (the worker supported it, the
 * client tool didn't — see #487). PM, UX, and CR all signed off without checking
 * the tool's real inputSchema. This guard makes that check structural so nobody
 * has to remember it.
 *
 * ── Layer 1 (AUTO) ──
 *   Every `borg_<tool>` token in the scanned copy surfaces must be a registered
 *   tool name. Catches renamed / typo'd / removed tool refs.
 *
 * ── Layer 2 (SELF-ENFORCING via inline markers — gh#529) ──
 *   Each copy site that tells the user to pass a param carries an INLINE,
 *   machine-readable marker next to the copy:
 *
 *       // copy-param-claim: borg_update-cube.message_taxonomy
 *
 *   The guard ENUMERATES every marker across the copy surfaces and asserts the
 *   named param is a real inputSchema property of the named tool. This is the
 *   gh#490-v2 follow-up that the original seed-only Layer 2 deferred: the claim
 *   now lives co-located with the copy (added in the same file/diff hunk as the
 *   copy it documents), not in a remote hand-seeded array that a new
 *   copy-with-params could silently bypass. It mirrors gh#518's db.admin
 *   permit-list: the (tool, param) facts are enumerated from source and checked
 *   deterministically, with zero prose→param inference.
 *
 * NOT in scope (deliberately): fuzzy auto-extraction of "which param does this
 * prose mean" (e.g. "taxonomy array" -> message_taxonomy). Prose->param
 * inference is non-deterministic and would make CI flaky — the marker convention
 * is the deterministic substitute, and CONFLICT/reject-default semantics are out
 * of scope for this enumerate-and-check rail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

// gh#docs-site: the borg_* tool definitions moved out of index.ts into a pure-data
// source-of-truth module (tool-manifest.ts) so the docs site can import them
// without the client's runtime deps. index.ts registers TOOL_MANIFEST verbatim.
const TOOL_REGISTRY = 'src/tool-manifest.ts';

// User-facing copy surfaces that may name borg_ tools.
const COPY_SURFACES = ['src/regen-format.ts'];

/**
 * Inline copy-param marker: `copy-param-claim: <tool>.<param>`. Lives in a
 * comment next to the copy that recommends passing `param` to `tool`. Tool names
 * are `borg_*`; params are inputSchema property names (snake_case identifiers).
 */
const COPY_PARAM_MARKER_RE = /copy-param-claim:\s*(borg_[a-z0-9_-]+)\.([A-Za-z0-9_]+)/;

interface CopyParamMarker {
  surface: string;
  tool: string;
  param: string;
  line: number;
}

/** Enumerate `copy-param-claim:` markers in a copy source -> [{tool, param, line}]. */
function extractCopyParamMarkers(surface: string, src: string): CopyParamMarker[] {
  const markers: CopyParamMarker[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = COPY_PARAM_MARKER_RE.exec(lines[i]);
    if (m) markers.push({ surface, tool: m[1], param: m[2], line: i + 1 });
  }
  return markers;
}

/** All markers across every copy surface. */
function allCopyParamMarkers(): CopyParamMarker[] {
  return COPY_SURFACES.flatMap((s) => extractCopyParamMarkers(s, read(s)));
}

/** Tool names registered in src/index.ts (all tools are borg_* — incl. the auth tools). */
function registeredToolNames(indexSrc: string): Set<string> {
  const names = new Set<string>();
  for (const m of indexSrc.matchAll(/name: '(borg_[a-z_-]+)'/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Distinct `borg_<tool>` tokens referenced in a copy source. */
function copyToolRefs(copySrc: string): Set<string> {
  return new Set([...copySrc.matchAll(/borg_[a-z_-]+/g)].map((m) => m[0]));
}

/**
 * The same, but with `copy-param-claim:` marker lines stripped first. Used for
 * the staleness check so a marker's own embedded tool name can't satisfy
 * "the copy still mentions this tool" — only the real user-facing copy can.
 */
function copyToolRefsExcludingMarkers(copySrc: string): Set<string> {
  const stripped = copySrc
    .split('\n')
    .filter((l) => !COPY_PARAM_MARKER_RE.test(l))
    .join('\n');
  return copyToolRefs(stripped);
}

/** Source slice for one tool's registration block (name: up to the next tool's name:). */
function toolBlock(indexSrc: string, tool: string): string {
  const start = indexSrc.indexOf(`name: '${tool}'`);
  if (start < 0) throw new Error(`tool ${tool} not registered in ${TOOL_REGISTRY}`);
  const next = indexSrc.slice(start + 1).search(/name: '(borg_[a-z_-]+)'/);
  return next < 0 ? indexSrc.slice(start) : indexSrc.slice(start, start + 1 + next);
}

/**
 * True if `tool`'s inputSchema declares a property named `param`. Matches a real
 * property declaration (`<indent>param: {`), not a prose mention of the name.
 */
function toolExposesParam(indexSrc: string, tool: string, param: string): boolean {
  return new RegExp(`\\n\\s+${param}:\\s*\\{`).test(toolBlock(indexSrc, tool));
}

describe('gh#490 — copy↔mechanism guard', () => {
  const indexSrc = read(TOOL_REGISTRY);
  const registered = registeredToolNames(indexSrc);

  it('the tool registry parsed (sanity — registry is non-empty + has known tools)', () => {
    expect(registered.size).toBeGreaterThan(20);
    expect(registered.has('borg_update-cube')).toBe(true);
    expect(registered.has('borg_regen')).toBe(true);
  });

  describe('Layer 1 — every borg_ tool named in copy is registered', () => {
    for (const surface of COPY_SURFACES) {
      it(`${surface}: no reference to an unregistered borg_ tool`, () => {
        const refs = copyToolRefs(read(surface));
        const unknown = [...refs].filter((t) => !registered.has(t));
        expect(
          unknown,
          `${surface} names borg_ tool(s) not registered in ${TOOL_REGISTRY}: [${unknown.join(', ')}]. ` +
            `Fix the copy or the tool name (renamed/removed/typo).`,
        ).toEqual([]);
      });
    }
  });

  describe('Layer 2 — every inline copy-param-claim marker names a real inputSchema param', () => {
    const markers = allCopyParamMarkers();

    it('coverage floor: the #479 taxonomy claim is marked at its copy site (convention not silently dropped)', () => {
      // Anchors the convention so Layer 2 can never collapse to a zero-marker
      // no-op: the originating #479 regression must stay covered by a marker.
      const taxonomyMarker = markers.find(
        (m) =>
          m.surface === 'src/regen-format.ts' &&
          m.tool === 'borg_update-cube' &&
          m.param === 'message_taxonomy',
      );
      expect(
        taxonomyMarker,
        'Expected a `copy-param-claim: borg_update-cube.message_taxonomy` marker at the ' +
          'nullTaxonomyTip copy site in src/regen-format.ts (the #479 miss class).',
      ).toBeDefined();
    });

    // One generated assertion per enumerated marker — deterministic, no prose
    // inference. New copy-with-params adds a marker next to the copy and is
    // checked here automatically.
    for (const marker of markers) {
      it(`${marker.surface}:${marker.line} — ${marker.tool} exposes \`${marker.param}\``, () => {
        expect(
          registered.has(marker.tool),
          `copy-param-claim names ${marker.tool}, which is not a registered tool in ${TOOL_REGISTRY}`,
        ).toBe(true);
        // Staleness: the marker must accompany real copy that still names the
        // tool (marker lines stripped so the marker can't satisfy itself).
        expect(
          copyToolRefsExcludingMarkers(read(marker.surface)).has(marker.tool),
          `copy-param-claim marks ${marker.tool} but ${marker.surface} copy no longer mentions it — ` +
            `remove the stale marker or restore the copy.`,
        ).toBe(true);
        // Core check: the tool must actually expose the param the copy promises.
        expect(
          toolExposesParam(indexSrc, marker.tool, marker.param),
          `${marker.tool} inputSchema does not expose '${marker.param}', but a copy-param-claim in ` +
            `${marker.surface}:${marker.line} promises it. Expose the param in ${TOOL_REGISTRY} or fix the copy/marker.`,
        ).toBe(true);
      });
    }
  });

  it('the marker extractor is not a no-op (parses tool + param + line from a synthetic source)', () => {
    const synthetic = [
      'export function tip() {',
      '  // copy-param-claim: borg_update-cube.message_taxonomy',
      "  return 'Use borg_update-cube ...';",
      '}',
      '// not a marker: borg_regen has no param here',
    ].join('\n');
    const markers = extractCopyParamMarkers('synthetic.ts', synthetic);
    expect(markers).toEqual([
      { surface: 'synthetic.ts', tool: 'borg_update-cube', param: 'message_taxonomy', line: 2 },
    ]);
  });

  it('the param detector is not a no-op (real prop matches, bogus prop does not)', () => {
    expect(toolExposesParam(indexSrc, 'borg_update-cube', 'message_taxonomy')).toBe(true);
    expect(toolExposesParam(indexSrc, 'borg_update-cube', 'cube_id')).toBe(true);
    expect(toolExposesParam(indexSrc, 'borg_update-cube', 'definitely_not_a_real_param')).toBe(false);
  });

  it('taxonomy-editing tools expose lifecycle so full replacements do not drop stuck-ping tags', () => {
    expect(toolExposesParam(indexSrc, 'borg_update-cube', 'lifecycle')).toBe(true);
    expect(toolExposesParam(indexSrc, 'borg_patch-taxonomy-class', 'lifecycle')).toBe(true);
  });
});
