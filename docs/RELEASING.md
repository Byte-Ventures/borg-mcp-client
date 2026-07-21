# Publishing `borgmcp`

The GitHub Actions workflow publishes one immutable, reviewed `borgmcp` version
from a protected annotated tag. The protected publish job uses npm Trusted
Publishing; no long-lived npm token is stored or exposed.

## Immutable Release Evidence

The existing lightweight `v2.0.0` tag points to
`90a078264f4d61c0140ad0a30357a4df42c34ab0`. Immutable workflow run
`29693915689` rejected it at annotated-tag verification and failed before package
creation or npm publication; the publish job was skipped and
`borgmcp@2.0.0` remains absent from npm. Never delete, move, replace, reuse, or
rerun that tag or run.

The annotated `v2.0.1` tag object
`def12ee40af665fc6c3af4873a7d566b3f844fc1` peels to protected-main commit
`b30fc54a4d73bda98db4630864cca796c8923dd9`. Workflow run `29748931957`
successfully published that exact source as `borgmcp@2.0.1`; the registry records
integrity
`sha512-Ah8IY2izZ774gYLKthRL9lfrV+JBk2o9HSlrWUplyZgoGqwVjVboHNon0hWWF5i/fObiCGikFOMY6qZ+vaeyCw==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
uses the unused `v2.0.2` identity from a fresh reviewed protected-main commit
and requires the complete release gate again.

## Release Prerequisites

The standalone client was extracted from private-monorepo commit
`17ff8ce14e12122a8cc9089f6b94174c02fa2a04` without importing its Git history.
Before creating the release tag, independently verify all of these conditions:

- the extraction review confirms no private backend secrets, deployment
  configuration, customer data, local state, or duplicated shared contracts
  entered the public package;
- the exact audited registry dependency `borgmcp-shared@0.4.3` remains locked to
  its canonical tarball and integrity;
- the client and matching server pass the complete local dogfood gate;
- the selected stable client version is unused and the exact release commit is
  on protected `main`;
- the repository and protected npm environment settings pass an operator audit;
- the exact release source passes Code Review, Security Review, Release Quality,
  extraction, and package gates; and
- the immutable annotated tag and publication receive explicit release
  authorization.

`scripts/verify-release-readiness.mjs` makes the source-side blockers
machine-checkable. A release tag created before they are resolved fails before
dependency installation or publication.

## Repository Controls

Repository settings are operator-owned and are not changed by this workflow.
Before preparing a candidate, independently verify:

1. The `npm-publish` environment disables administrator bypass, requires the
   reviewed human approver, and allows only the protected release refs. Its
   `NPM_EXPECTED_OWNER` variable must match the sole reviewed maintainer of the
   existing `borgmcp` package. It must contain no npm token.
2. npm Trusted Publishing is configured for organization `Byte-Ventures`,
   repository `borg-mcp-client`, workflow `publish.yml`, and environment
   `npm-publish`.
3. `refs/tags/v*.*.*` cannot be updated, deleted, or force-moved. Release tags
   are annotated, match the package version, and point to a commit on protected
   `main`.
4. `main` requires reviewed pull requests, resolved threads, and current CI.
5. GitHub Actions permits only the full-SHA-pinned GitHub-owned actions present
   in this repository. The default workflow token remains read-only.
6. Private vulnerability reporting, secret scanning, push protection, CodeQL,
   and Dependabot security updates remain enabled.

## Release Workflow

The only trigger is a protected annotated `v<package version>` tag. Manual
dispatch is intentionally absent so a second run cannot rebuild or publish an
existing tag. The workflow rejects reruns, root `.npmrc`
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
   release artifact.

The protected `publish` job alone receives `id-token: write`. It downloads the
same-run artifact and rejects a report whose package name or version differs
from the release, a version that already exists, an unclaimed package, or an
owner set that differs from `NPM_EXPECTED_OWNER`. It requires the GitHub OIDC
request context, rejects a legacy `NODE_AUTH_TOKEN`, and publishes the exact
tarball path once with lifecycle scripts disabled and provenance enabled. It
does not install project dependencies, rebuild, retest, repack, or reverify the
package.

The dependent, unprivileged `registry-verification` job has no environment or
OIDC permission. It polls registry visibility with fixed attempt and delay
bounds, compares `dist.integrity` exactly with the same-run report, installs the
exact published version with lifecycle scripts disabled, and runs
`npm audit signatures` to verify registry signatures and the Trusted Publishing
attestation.

No separate checksum file is needed: the tarball verifier records canonical
SHA-512 SRI in the artifact report. GitHub's same-run artifact transport and the
report bind the reviewed candidate without repeated SHA512 choreography.

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
