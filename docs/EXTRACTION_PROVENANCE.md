# Extraction Provenance

The initial standalone source was extracted from `Byte-Ventures/borg-mcp` commit `17ff8ce14e12122a8cc9089f6b94174c02fa2a04` on branch `main`.

The extraction copied the monorepo's `client/src/` production boundary and top-level `client/__tests__/*.test.ts` unit tests. It did not import monorepo Git history, worker or website source, deployment configuration, local state, credentials files, build output, or the live integration suite.

[`provenance/extraction-map.json`](../provenance/extraction-map.json) records every one of the 225 source-client files with source and destination SHA-256 hashes plus one of four dispositions: byte-identical copy, standalone transformation, shared-package replacement, or exclusion. The map is generated against the detached exact-source checkout with `scripts/generate-extraction-map.mjs`; it is repository evidence and is not included in the npm artifact.

## Deliberate Transformations

- Replaced the monorepo dependency on `borgmcp-shared` with the exact audited registry release `borgmcp-shared@0.3.0` and a fresh standalone lockfile.
- Replaced local template, role-section, drone-address, and log high-water-mark implementations with `borgmcp-shared` exports.
- Removed monorepo-only website anti-drift tests and re-anchored remaining filesystem tests to this repository.
- Removed consumer lifecycle hooks, parent-directory deployment scripts, minification, and private integration-environment configuration.
- Added standalone source typecheck, unit/release tests, readable build, onboarding smoke, artifact verification, and public-source sensitivity scanning.
- Made the package root export side-effect-free while retaining `borg-mcp` executable behavior.
- Hardened the Desktop OAuth callback to an exact IPv4 loopback binding with
  transaction state, bounded static responses, and adversarial callback tests;
  test-only Google client-ID lookalikes use the reserved `.test` domain.
- Kept self-hosted `--host --enroll` preview-only while implementing the
  client-generated PENDING credential/retry tuple and capability-gated,
  repository-idempotent cube creation required for local dogfood.
- Retained the existing package version `1.1.15`; extraction does not authorize a version bump or release.

## Review Holds

The installed-application OAuth credentials in `src/auth.ts` were already distributed in prior npm artifacts. Security classified them as public-client distribution material only if an operator verifies in Google Console that the exact clients belong to the Byte Ventures project and are registered respectively as Desktop and TVs/Limited Input clients. `scripts/verify-public-source.mjs` permits only the four pinned values in `src/auth.ts` and their generated copies in `dist/auth.js`; any additional Google OAuth client ID or `GOCSPX` value fails the scan.

The pinned SHA-256 fingerprints, in Desktop client ID, Desktop public-client value, TVs/Limited Input client ID, and TVs/Limited Input public-client value order, are:

- `fe93485615a89f3db7132351877d7215b69de3ba5bc25bed32a28c08697f7242`
- `ae958146e8947f46544e8e162f9d0b157cac29cd4d4854cf9e295f3f0b6b115f`
- `385408ac72401565fd40515635041d4bd33d9e8bc19488bfc4b237605dcdffef`
- `6915f25f028886263d0d4a649a1d1c4135413ce3c75fb3abd4dbe5916d804031`

Local enrollment now uses the reviewed client-generated credential/retry
contract, with a pre-request `PENDING` keychain record, exact-tuple ambiguous
retry, verified activation, and no file fallback. The contract now resolves to
the audited registry `borgmcp-shared@0.3.0`; release remains blocked until the
matching server passes the process-level setup→create→attach→restart→log/SSE gate.
