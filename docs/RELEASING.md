# Preparing `borgmcp` Release Candidates

Client npm publication is deferred. The current GitHub Actions workflow prepares
one immutable npm release candidate for review but contains no publication
command, OIDC permission, npm token, or registry mutation. A tag or successful
candidate run does not authorize publication.

## Current Release Blockers

The standalone client was extracted from private-monorepo commit
`17ff8ce14e12122a8cc9089f6b94174c02fa2a04` without importing its Git history.
Publication remains blocked until all of these conditions are independently
reviewed and satisfied:

- the extraction review confirms no private backend secrets, deployment
  configuration, customer data, local state, or duplicated shared contracts
  entered the public package;
- the exact audited registry dependency `borgmcp-shared@0.4.2` remains locked to
  its canonical tarball and integrity;
- the client and matching server pass the complete local dogfood gate;
- an unused stable client version and exact release commit are selected;
- the repository and protected npm environment settings pass an operator audit;
- the exact release candidate passes Code Review, Security Review, Release
  Quality, extraction, and package gates; and
- a separate change explicitly activates Trusted Publishing and receives human
  publication authorization.

`scripts/verify-release-readiness.mjs` makes the source-side blockers
machine-checkable. A release tag created before they are resolved fails before
dependency installation or candidate creation.

## Repository Controls

Repository settings are operator-owned and are not changed by this workflow.
Before preparing a candidate, independently verify:

1. The `npm-publish` environment disables administrator bypass, requires the
   reviewed human approver, and allows only the protected release refs. Its
   `NPM_EXPECTED_OWNER` variable must match the sole reviewed maintainer of the
   existing `borgmcp` package. It must contain no npm token.
2. npm Trusted Publishing is configured for organization `Byte-Ventures`,
   repository `borg-mcp-client`, workflow `publish.yml`, and environment
   `npm-publish`. This configuration is dormant while publication is deferred.
3. `refs/tags/v*.*.*` cannot be updated, deleted, or force-moved. Candidate tags
   are annotated, match the package version, and point to a commit on protected
   `main`.
4. `main` requires reviewed pull requests, resolved threads, and current CI.
5. GitHub Actions permits only the full-SHA-pinned GitHub-owned actions present
   in this repository. The default workflow token remains read-only.
6. Private vulnerability reporting, secret scanning, push protection, CodeQL,
   and Dependabot security updates remain enabled.

## Candidate Workflow

The only trigger is a protected annotated `v<package version>` tag. Manual
dispatch is intentionally absent so a second run cannot rebuild another
candidate for an existing tag. The workflow rejects reruns, root `.npmrc`
configuration, non-tag events, lightweight or malformed tags, version mismatch,
source/tag mismatch, and tags whose commits are not on protected `main`.

The unprivileged `verify` job performs one sequence:

1. Verify the public-source boundary, extraction readiness, exact shared-package
   pin, and canonical registry lock metadata.
2. Install the lockfile once with lifecycle scripts disabled and audit it.
3. Run type checks, tests, and one readable build; reject generated `dist` drift.
4. Produce one npm tarball.
5. Verify that tarball once for package identity, license/notice, source and map
   completeness, executable bins, archive safety, dependency integrity, and
   absence of credentials, private endpoints, local paths, links, or lifecycle
   hooks.
6. Install the exact local tarball once with scripts disabled and require package
   import plus MCP initialize/tool discovery through npm's generated bin shim.
7. Upload only the tarball and its verifier-generated report as the same-run
   candidate artifact.

The protected `publication-readiness` job downloads that same-run artifact and
performs read-only preflight. It rejects a report whose package name or version
differs from the candidate, a version that already exists, an unclaimed package,
or an owner set that differs from `NPM_EXPECTED_OWNER`. It then exits successfully
without publishing. It does not rebuild or reverify the package.

No separate checksum file is needed: the tarball verifier records canonical
SHA-512 SRI in the artifact report. GitHub's same-run artifact transport and the
report bind the reviewed candidate without repeated SHA512 choreography.

## Separately Authorized Activation

Actual publication requires a separate reviewed workflow change. That change
must preserve the candidate job unchanged and add only the minimum protected
mutation and readback path:

1. The protected publish job alone receives `id-token: write`; no long-lived npm
   token is stored or exposed.
2. It consumes the already-produced same-run tarball and report. It does not run
   dependency installation, project tests, build, pack, or packed-artifact
   verification again.
3. Immediately before mutation it repeats only immutable version availability,
   exact package identity, and reviewed-owner preflight.
4. It publishes the exact absolute tarball path once through npm Trusted
   Publishing with provenance and lifecycle scripts disabled.
5. A dependent verification job polls registry visibility with fixed attempt and
   delay bounds, compares `dist.integrity` exactly with the report, installs the
   exact version with scripts disabled, and runs `npm audit signatures`.

Rely on npm's signature and Trusted Publishing attestation validation. Do not
reconstruct DSSE, in-toto, SLSA, workflow-ref, or builder statements locally.
Do not add cross-run tuple variables, cross-run artifact selection, duplicate
builds, duplicate package verification, checksum bundles, or SBOM ceremony.

A post-publication verification failure is a release incident; it never means
the immutable npm publication did not happen and never authorizes a rerun.

## Stop And Recovery Conditions

Stop when source, settings, ownership, tag, artifact, test, audit, review, or
authorization evidence is missing or inconsistent. Never move or reuse a failed
tag, rerun a failed release workflow, overwrite an npm version, unpublish to hide
a failure, or substitute a local rebuild. Recovery starts from a fresh reviewed
source change and, after any registry mutation, a separately authorized version.
