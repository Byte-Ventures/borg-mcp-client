# Extraction Provenance

The initial standalone source was extracted from `Byte-Ventures/borg-mcp` commit `17ff8ce14e12122a8cc9089f6b94174c02fa2a04` on branch `main`.

The extraction copied the monorepo's `client/src/` production boundary and top-level `client/__tests__/*.test.ts` unit tests. It did not import monorepo Git history, worker or website source, deployment configuration, local state, credentials files, build output, or the live integration suite.

[`provenance/extraction-map.json`](../provenance/extraction-map.json) records every one of the 225 source-client files with source and destination SHA-256 hashes plus one of four dispositions: byte-identical copy, standalone transformation, shared-package replacement, or exclusion. The map is generated against the detached exact-source checkout with `scripts/generate-extraction-map.mjs`; it is repository evidence and is not included in the npm artifact.

## Deliberate Transformations

- Replaced the Git dependency on `borgmcp-shared` with registry range `^0.2.0` and a fresh canonical npm lockfile.
- Replaced local template, role-section, drone-address, and log high-water-mark implementations with `borgmcp-shared` exports.
- Removed monorepo-only website anti-drift tests and re-anchored remaining filesystem tests to this repository.
- Removed consumer lifecycle hooks, parent-directory deployment scripts, minification, and private integration-environment configuration.
- Added standalone source typecheck, unit/release tests, readable build, onboarding smoke, artifact verification, and public-source sensitivity scanning.
- Made the package root export side-effect-free while retaining `borg-mcp` executable behavior.
- Retained the existing package version `1.1.15`; extraction does not authorize a version bump or release.

## Review Holds

The installed-application OAuth credentials in `src/auth.ts` were already distributed in prior npm artifacts and are intentionally classified by the source as public-client credentials. Public-source Security review must confirm that classification before release.

Local enrollment still uses the pre-redesign server-generated bearer response. The reviewed shared contract must move to client-generated credential plus retry key, a pre-request `PENDING` keychain record, exact-tuple ambiguous retry, verified activation, and no file fallback before local dogfood release.
