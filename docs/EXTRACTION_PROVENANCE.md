# Extraction Provenance

The initial standalone source was extracted from `Byte-Ventures/borg-mcp` commit `17ff8ce14e12122a8cc9089f6b94174c02fa2a04` on branch `main`.

The extraction copied the monorepo's `client/src/` production boundary and top-level `client/__tests__/*.test.ts` unit tests. It did not import monorepo Git history, worker or website source, deployment configuration, local state, credentials files, build output, or the live integration suite.

[`provenance/extraction-map.json`](../provenance/extraction-map.json) records every one of the 225 source-client files with source and destination SHA-256 hashes plus one of four dispositions: byte-identical copy, standalone transformation, shared-package replacement, or exclusion. The map is generated against the detached exact-source checkout with `scripts/generate-extraction-map.mjs`; it is repository evidence and is not included in the npm artifact.

## Deliberate Transformations

- Replaced the monorepo dependency on `borgmcp-shared` with the exact audited registry release `borgmcp-shared@0.5.0` and a fresh standalone lockfile.
- Replaced local template, role-section, drone-address, and log high-water-mark implementations with `borgmcp-shared` exports.
- Removed monorepo-only website anti-drift tests and re-anchored remaining filesystem tests to this repository.
- Removed consumer lifecycle hooks, parent-directory deployment scripts, minification, and private integration-environment configuration.
- Added standalone source typecheck, unit/release tests, readable build, onboarding smoke, artifact verification, and public-source sensitivity scanning.
- Made the package root export side-effect-free while retaining `borg-mcp` executable behavior.
- Kept self-hosted `--host --enroll` preview-only while implementing the
  client-generated PENDING credential/retry tuple and capability-gated,
  repository-idempotent cube creation required for local dogfood.
- Initially set the standalone package identity to `2.0.0`. Its immutable
  lightweight release tag failed before packaging. The reviewed `2.0.1`
  recovery, `2.0.2`, `2.0.3`, `2.0.4`, `2.0.5`, and `2.0.6` successors were
  published and registry-verified. The immutable `2.0.7` workflow failed before
  package creation or npm publication, so the next candidate identity is `2.0.8`.
  Extraction and versioning do not authorize publication.

## Review Holds

Google OAuth / Cloud sign-in has been fully removed from this local-only client.
`src/auth.ts`, `src/device-auth.ts`, and all installed-application OAuth client
material are deleted, along with the hosted API default and the Cloud
subscription/billing/dashboard tools. `scripts/verify-public-source.mjs` now
forbids ANY Google OAuth client ID or `GOCSPX` value anywhere in the source or
packed artifact (zero tolerance), and a no-cloud egress guard asserts the packed
artifact reaches no hosted authority.

Local enrollment now uses the reviewed client-generated credential/retry
contract, with a pre-request `PENDING` record in the local 0600-permission seat
store, exact-tuple ambiguous retry, and verified activation. The contract now
resolves to the audited registry `borgmcp-shared@0.5.0`. The matching
`borgmcp-server@0.1.8` release is published and registry-verified. Client
`borgmcp@2.0.6` is published and registry-verified. The immutable `v2.0.7`
attempt failed before publication and remains preserved. Publication of the next
candidate remains gated by reviewed `v2.0.8` source, a fresh annotated tag, and
exact registry integrity and signature verification.
