# Extraction Provenance

The initial standalone source was extracted from `Byte-Ventures/borg-mcp` commit `17ff8ce14e12122a8cc9089f6b94174c02fa2a04` on branch `main`.

The extraction copied the monorepo's `client/src/` production boundary and top-level `client/__tests__/*.test.ts` unit tests. It did not import monorepo Git history, worker or website source, deployment configuration, local state, credentials files, build output, or the live integration suite.

[`provenance/extraction-map.json`](../provenance/extraction-map.json) records every one of the 225 source-client files with source and destination SHA-256 hashes plus one of four dispositions: byte-identical copy, standalone transformation, shared-package replacement, or exclusion. The map is generated against the detached exact-source checkout with `scripts/generate-extraction-map.mjs`; it is repository evidence and is not included in the npm artifact.

## Deliberate Transformations

- Replaced the monorepo dependency on `borgmcp-shared` with the exact audited registry release pinned at extraction time (0.6.4) and a fresh standalone lockfile.
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
  package creation or npm publication. The `2.0.8`, `2.0.9`, `2.0.10`, `2.0.11`,
  `2.1.0`, and `2.1.1` successors were published, and `2.2.0` was subsequently published, and `2.3.0` was subsequently published, and `2.4.0` was subsequently published, and `2.4.1` was subsequently published, and `2.5.0` was subsequently published, and `2.6.0` was subsequently published, and `2.6.1` was subsequently published, and `2.7.0` was subsequently published, and `2.7.1` was subsequently published, and `2.7.2` was subsequently published, and `2.7.3` was subsequently published, and `2.8.0` was subsequently published, and `2.9.0` was subsequently published, and `2.10.0` was subsequently published, and the immutable `2.10.1` release attempt failed before artifact creation or publication. The `2.10.2`, `2.11.0`, `2.12.1`, and `2.13.0` successors were published; the immutable `2.12.0` attempt failed before artifact creation or publication and was superseded by `2.12.1`. The current release identity is `2.15.0`. Extraction and
  versioning do not authorize publication.

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
store, exact-tuple ambiguous retry, and verified activation. The current client
candidate resolves to the audited registry `borgmcp-shared@0.9.0` with integrity
`sha512-bfZPP9JGgBQrCFoZetabqKHc8HLaUqHVR3GJLb/1F1oon7z/B4el4aeBHVvXlxN9+2G7kU/ymPZ/K25nVQapmQ==`.
The coupled `borgmcp-server@0.9.0` release was published on 2026-08-02 for the
client `borgmcp@2.10.0` line. Its annotated tag object
`7021a2e1f551aa0c1716c9e3f29f7b8bc4b0ccb0` peels to protected-main commit
`734051375d77013f8fd5b396af12feb53d5af96d`; the same-run artifact integrity is
`sha512-lOxIPg3WcjSBte46iTM7SAFVN6Y0b2oizOKAJ9Q1EijBdOlmsh/cQlpUIaa8F2UJPaTDFsXy3M64gpGs6XgKzA==`
in the `borgmcp-server-0.9.0-release` registry decision. That server and its
client line pin historical `borgmcp-shared` version `0.8.1` and remain
immutable. Client `borgmcp@2.14.1` is published. The immutable `v2.0.7`
attempt failed before publication and remains preserved. The current release identity and publication gate remain governed by the reviewed `v2.15.0` source, a fresh annotated tag, and
the exact-artifact and protected-publication gates.
