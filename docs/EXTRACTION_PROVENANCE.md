# Extraction Provenance

The initial standalone source was extracted from `Byte-Ventures/borg-mcp` commit `17ff8ce14e12122a8cc9089f6b94174c02fa2a04` on branch `main`.

The extraction copied the monorepo's `client/src/` production boundary and top-level `client/__tests__/*.test.ts` unit tests. It did not import monorepo Git history, worker or website source, deployment configuration, local state, credentials files, build output, or the live integration suite.

[`provenance/extraction-map.json`](../provenance/extraction-map.json) records every one of the 225 source-client files with source and destination SHA-256 hashes plus one of four dispositions: byte-identical copy, standalone transformation, shared-package replacement, or exclusion. The map is generated against the detached exact-source checkout with `scripts/generate-extraction-map.mjs`; it is repository evidence and is not included in the npm artifact.

## Deliberate Transformations

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
immutable. The immutable `v2.0.7` attempt failed before publication and remains
preserved. Each release's identity and publication gate are governed by its reviewed
source at the annotated release tag and the exact-artifact and
protected-publication gates; the authoritative version is `package.json` and
the registry, not this document.
