# Repository Guidance

## Setup And Checks

- Use Node.js 22.12+. `build`, `check`, `dev`, `test:unit` and `test:release` run `scripts/node-preflight.mjs` first and fail fast on an older runtime; `clean`, `start`, `onboarding:smoke` and the `verify:*` scripts invoke node directly and do not.
- Install with `npm ci`.
- **`dist/` is generated output and it is TRACKED IN GIT** — 464 files, listed in `files`, with no `.gitignore` rule. Never hand-edit it: run `npm run build` and commit the result. `publish.yml` rebuilds it and then runs `git diff --exit-code -- dist`, so committed output that does not match a fresh build fails the release.
- Run one test file with `npx vitest run test/<name>.test.ts`, or one named test with `-t '<test name>'`.
- `npm test` is two suites: `test:unit` (Vitest) and `test:release` (`node --test test/release-lane.test.mjs`). Both must pass before merge; CI runs unit tests on the Node floor/current and release policy once.
- `npm run check` is typecheck only. It does not run tests, and it passes on a tree whose tests fail.
- There is no lint or formatter command. Do not invent one or reformat unrelated code.

## Code Map

`src/` is flat and large (110+ modules). The groupings that matter:

- `src/index.ts` is the MCP server entry (`borg-mcp`). `src/claude.ts` backs the `borg` launcher, `src/setup.ts` backs `borg setup`.
- Agent launchers are per-CLI and top-level: `claude-launch-args.ts`, `codex-launch.ts`, `opencode-drone.ts` and siblings. `src/backends/` holds only the three multi-drone launchers (`launch-all-tmux.ts`, `launch-all-pastelist.ts`, `launch-all-terminals.ts`). Borg runs an agent CLI the user installed; it never installs one.
- `src/cli-help.ts` composes all `--help` output. It is the first surface a new user reads, and it is a separate render surface from the README — a term defined only in the README is undefined here.
- `src/docs-sections.ts` is the section index `borg_docs` serves to agents. It is a third documentation surface; a concept added to the README and the help text is still missing here.
- `src/config.ts`, `src/cubes.ts`, `src/credential-paths.ts` own on-disk state under the user's config root. Treat every path there as the operator's data.
- Protocol envelopes, domain types, and conformance vectors live in the separately released `borgmcp-shared` dependency. Change that contract there first, then consume an exact published version here.

## Invariants

- Borg wraps an agent CLI the user already installed. It does not install Claude Code, Codex, or OpenCode, and it does not teach their installation. `borg setup` does two things: it configures the installed CLIs the user selected (`src/setup.ts:214-237`), and it initializes the separately published local server (`:200-210`). It installs no agent CLI.
- The client is local-first: no accounts, no subscriptions, no hosted API. A change that introduces a remote authority is an architectural change, not a feature.
- Vocabulary MUST be defined before use on every surface that ships. `cube`, `drone` and `role` are defined in the README. `seat` is not: it reaches users through `--help` (`borg reset-local-seat`) and the `borg_docs` index, and appears in the README only inside a URL — so no shipped surface carries both the word and its definition. That is a live exception, tracked in client#366, not a satisfied invariant. A definition added to one surface does not travel to the others.

## Release Boundaries

- **Two files carry the version and must move together:** `package.json` (`version`) and `package-lock.json` (`version` and `packages[""].version`). `npm run verify:release` checks the top-level lockfile version against the manifest.

- `npm run release:check` runs the full release lane: public-source scan, release readiness, lock-registry check, typecheck, tests, build, onboarding smoke, and package verification.
- Releases are tag-triggered and immutable. Never move or reuse a tag. A pre-stage workflow failure may be rerun; npm stage acceptance consumes the version. Check the registry before naming a version.
- Follow `docs/RELEASING.md`. A merged release-prep PR does not authorize tagging or publication.
- `docs/EXTRACTION_PROVENANCE.md` ships to npm and records spent versions. Its current-release-identity statements move with a bump. Record a spent version in its table; never append a clause to the entry.

## Documentation Surfaces

`docs/*.md` is in `files`, so every one of them ships to npm and renders on the package page. The README's relative links must resolve inside the packed tarball, not just on GitHub — verify README-class changes on GitHub at the merge SHA, in the unpacked published tarball, and for in-package link resolution.
