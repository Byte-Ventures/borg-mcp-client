# scripts

## Overview

Node ESM build, release, and CI scripts for the `borgmcp` package. None of
them ship in the npm tarball (`scripts/` is not in `package.json` `files`).
Most release-lane scripts export their checks as functions and also run as a
CLI when invoked directly (`invokedPath === fileURLToPath(import.meta.url)`).
`test/release-lane.test.mjs` imports those functions. Follow
`docs/RELEASING.md` for the release order; running a script here does not
authorize a tag or a publish.

## Interface

| File | Invoked by | Exports | Purpose |
| --- | --- | --- | --- |
| `clean.mjs` | `npm run clean`, `npm run build` | none | Deletes `dist/` recursively. |
| `node-preflight.mjs` | `npm run preflight:node`, and through it `build`, `check`, `dev`, `test:unit`, `test:release` | `satisfiesNodeRequirement(version, requirement)` | Fails (exit code 1) when `process.versions.node` is below `package.json` `engines.node`, or when that field is not a `>=major.minor.patch` requirement. |
| `set-bin-mode.mjs` | `npm run build` (last step) | none | `chmod 0o755` on every `package.json` `bin` target. |
| `onboarding-smoke.mjs` | `npm run onboarding:smoke` (in `release:check`); `ci.yml` (`client` job) | none | Runs built `dist/claude.js` with `--version`, `--help`, `assimilate --help`, `server cube init --help`; checks the version string, the onboarding text, and equality with `cubeInitHelpText` from `dist/cli-help.js`. Requires a prior build. |
| `verify-public-source.mjs` | `npm run verify:public-source` (in `release:check`); `ci.yml`; `publish.yml` | none | Walks the working directory (skips `.git`, `.claude`, `.opencode`, `coverage`, `node_modules`, `release`, files > 4 MiB) and fails on private keys, npm/GitHub tokens, database URLs, private Worker and test endpoints, developer-local absolute home paths, monorepo-only imports, and any Google OAuth client material. |
| `verify-release-readiness.mjs` | `npm run verify:release` (in `release:check`); `publish.yml`; imported by `verify-packed-artifact.mjs` (`verifyManifest`) and `verify-lock-registry.mjs` (`lockRegistryEntries`) | `registryCompatible`, `verifyManifest`, `lockRegistryEntries`, `verifyReleaseReadiness`, `verifyReleasePreflight` | Checks required files, no repository `.npmrc`, manifest policy (`verifyManifest`), lockfile identity and root deps against `package.json`, and the exact `borgmcp-shared` pin (`SHARED_VERSION`, `SHARED_TARBALL`, `SHARED_INTEGRITY`). The CLI runs `verifyReleasePreflight`, which also requires the published `borgmcp-server@latest` to pin the same `borgmcp-shared` version. |
| `verify-lock-registry.mjs` | `npm run verify:lock` (in `release:check`); `publish.yml` | `verifyRegistryMetadata`, `verifyLockRegistry` | For every registry entry in `package-lock.json` (max 2048), fetches npm metadata (concurrency 8; retries on 429/5xx with delays 250, 1000, 3000 ms) and requires matching name, version, tarball URL, and integrity. |
| `verify-packed-artifact.mjs` | `npm run verify:artifact`; `publish.yml`; imported by `verify-local-package.mjs` | `verifyPackedArtifact(tarballPath, options)` | Policy check of an `npm pack` tarball; returns `{name, version, fileCount, packedBytes, unpackedBytes, sourceMapCount, integrity}`. See Invariants. |
| `local-dashboard-occurrences.json` | data, read by `verify-packed-artifact.mjs` and `__tests__/no-cloud-egress.test.ts` | n/a | Allowlist of exact `{file, line}` pairs permitted to contain the word `dashboard` in shipped `.js`/`.ts`. |
| `smoke-packed-client.mjs` | no npm script; `publish.yml`; imported by `verify-local-package.mjs` | `isolatedClientEnv`, `smokePackedClient(packageRoot, options)` | Exercises an installed package in an isolated home: root import, `borg-mcp` MCP stdio handshake (`initialize`, `tools/list`, `tools/call borg_version`, `borg_tool`, `borg_describe_tool`), and the `borg server ...` facade against a fake `borg-mcp-server` shim. CLI: `<installed-package-root> [generated-bin]`. |
| `verify-local-package.mjs` | `npm run verify:package` (in `release:check`); `ci.yml` (`client` job) | none | `npm pack --ignore-scripts` into a temp dir, `verifyPackedArtifact`, global install into a temp prefix, `npm ls`, then `smokePackedClient`. Prints both reports. |
| `release-exercise.mjs` | `npm run release:exercise` (runs `build` first) | `parseReleaseExerciseArgs`, `ptyCommand`, `isolatedClientEnv`, `snapshotOperatorConfig`, `assertJourneyTranscript`, `assertServerProcessArgv`, `assertArtifactIdentity`, `resolvePackageEntry`, `exerciseRelease` | End-to-end exercise of a candidate client tarball with a real `borgmcp-server` artifact: installs both into a temp consumer, runs document, `server dashboard`, and start journeys under a Python PTY, and checks that the operator's global agent and Borg config did not change. Args: `--server <spec> --server-integrity <sha512-SRI> [--client-tarball <tgz>]`. Imports `test/support/real-server.mjs`. |
| `verify-release-trigger.mjs` | no npm script; `publish.yml` | `verifyReleaseTrigger({eventName, refType, refName, version})` | Requires a tag push whose name is exactly `v<package version>` (`GITHUB_EVENT_NAME`, `GITHUB_REF_TYPE`, `GITHUB_REF_NAME`). |
| `verify-registry-release.mjs` | no npm script; `publish.yml` (`prepublish` mode); imported by `create-github-release.mjs` (`verifyArtifactReport`) | `verifyArtifactReport`, `verifyOwner`, `verifyPrepublish`, `verifyPostpublish` | CLI: `<prepublish\|postpublish> <artifact-report.json>` with `EXPECTED_VERSION` (and `NPM_EXPECTED_OWNER` for prepublish). Prepublish requires the version to be absent (404) and the package to have exactly the expected single maintainer. Postpublish polls (12 x 5 s) and requires matching integrity; no workflow in `.github/workflows` runs postpublish mode. |
| `create-github-release.mjs` | no npm script; run manually per `docs/RELEASING.md`: `GITHUB_TOKEN="$(gh auth token)" node scripts/create-github-release.mjs <version>` | `assembleReleaseBody`, `createGithubRelease(version, deps)` | Creates the GitHub Release for `v<version>` on `Byte-Ventures/borg-mcp-client`. |
| `sha256-stdin.mjs` | no npm script, workflow, or other reference found in tracked files | none | Prints the hex SHA-256 of stdin; refuses input over 512 bytes. |

## Invariants

- `verify-packed-artifact.mjs` limits: packed <= 8 MiB, unpacked <= 30 MiB,
  <= 2048 files, each file <= 4 MiB. Allowed top-level roots only
  (`ALLOWED_ROOTS`); `dist/` only `.js`/`.d.ts` and maps, `src/` only `.ts`,
  `docs/` only `.md`, `hermes-plugin/` only the two
  `HERMES_PLUGIN_ARTIFACTS`. No links or special tar entries. No repository
  `.npmrc`.
- `verify-packed-artifact.mjs` content rules: `FORBIDDEN_CONTENT` in every
  file; `DOCS_FORBIDDEN_CONTENT` and `DOCS_STALE_RELEASE_FRAMING` in `.md`;
  every `borgmcp-shared@X.Y.Z` in shipped docs must equal the packed pin. In
  shipped code: no `CLOUD_RUNTIME_SYMBOLS`, no `LEGACY_AUTHORITY_ROUTE`,
  `registry.npmjs.org` appears exactly once and only in
  `EXPLICIT_NPM_REGISTRY_PATHS` (`src/update-cmd.ts`, `dist/update-cmd.js`),
  and every line containing `dashboard` must be listed in
  `local-dashboard-occurrences.json`. A new or edited `dashboard` line in
  `src/` or `dist/` therefore requires an allowlist update. No
  `DELETED_MODULE_BASENAMES` may ship. `LICENSE` SHA-1 and `NOTICE` text are
  fixed. Bin targets need a `#!/usr/bin/env node` shebang and the execute bit.
  Source maps are validated and at least one must exist.
- `verifyManifest` (`verify-release-readiness.mjs`) fixes: name `borgmcp`,
  license `Apache-2.0`, the provenance repository URL, `publishConfig` with
  only `access: public`, `engines.node === ">=22.13.0"`, an explicit `x.y.z`
  `version`, the `borg` and `borg-mcp` bin targets (the other six bins are not
  checked), the `main`/`types` targets, the `exports['.']` targets and the
  `./package.json` export, required scripts (`build`, `check`, `test`, `verify:artifact`), no
  consumer lifecycle hooks (`FORBIDDEN_HOOKS`), registry-only dependency specs,
  no bundled dependencies, and `borgmcp-shared` pinned to `SHARED_VERSION`
  (currently `3.0.0`). Bumping the shared pin requires editing the three
  `SHARED_*` constants together with `package.json` and `package-lock.json`.
- `node-preflight.mjs` reads the floor from `engines.node`; it does not hold
  its own version.
- `create-github-release.mjs` requires: a stable `x.y.z` version,
  `GITHUB_TOKEN`, an annotated tag `v<version>` with a non-empty subject,
  non-blank `docs/releases/<version>.md` at the tagged commit, a live npm
  version with a full SHA-512 integrity, and no existing GitHub Release for
  the tag.
- `release-exercise.mjs` requires macOS or Linux, `python3` (PTY), and npm
  exactly `11.18.0`.
- `smoke-packed-client.mjs` and `release-exercise.mjs` set `HOME`,
  `BORG_STATE_ROOT`, `CODEX_HOME`, and `XDG_CONFIG_HOME` (release-exercise
  also `CLAUDE_CONFIG_DIR`, `BORGMCP_TEST_FORBIDDEN_HOME`,
  `BORGMCP_TEST_ALLOWED_ROOTS`) to a temporary root so packed-client runs
  cannot write operator state.
- `verify-public-source.mjs` scans every file in the working tree, including
  contract files such as this one: never write a developer-local absolute
  path, token, or private endpoint into any file here.

## Side Effects

- Disk: `clean.mjs` deletes `dist/`; `set-bin-mode.mjs` changes file modes in
  `dist/`. `verify-packed-artifact.mjs`, `smoke-packed-client.mjs`,
  `verify-local-package.mjs`, and `release-exercise.mjs` create and remove
  `mkdtemp` directories under the OS temp dir.
- Subprocesses: `tar` (`verify-packed-artifact.mjs`); `npm pack`,
  `npm install --global --prefix <temp>`, `npm ls`
  (`verify-local-package.mjs`, `release-exercise.mjs`); the built `borg` and
  `borg-mcp` binaries; `release-exercise.mjs` also starts a real
  `borgmcp-server` on a free local port and stops it with SIGTERM/SIGKILL;
  `git` and `gh api` (`create-github-release.mjs`).
- Network (npm registry, read-only): `verify-lock-registry.mjs`,
  `verify-release-readiness.mjs` CLI (`borgmcp-server/latest`),
  `verify-registry-release.mjs`, `create-github-release.mjs`. Package
  installs in `verify-local-package.mjs` and `release-exercise.mjs` may also
  fetch dependencies.
- Network (GitHub, write): `create-github-release.mjs` POSTs a new Release to
  `repos/Byte-Ventures/borg-mcp-client/releases`. This is a publication step;
  run it only as `docs/RELEASING.md` directs.

## Verification

- Run: `npm test` (`test:release` runs `node --test
  test/release-lane.test.mjs`, which imports and tests
  `verify-packed-artifact`, `verify-lock-registry`, `verify-registry-release`,
  `verify-release-trigger`, `release-exercise`, `verify-release-readiness`,
  and `create-github-release`).
- Full release lane (network, build, pack): `npm run release:check`.
