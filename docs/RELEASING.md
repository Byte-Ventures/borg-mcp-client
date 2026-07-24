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
must use a fresh unused identity and requires the complete release gate again.

The annotated `v2.0.2` tag object
`a1fc1f8f05c3f1b4d7ccbef86e244955642165b5` peels to protected-main commit
`aced84956fdf41315904c8901e50a345f628152c`. Workflow run `29840120451`
successfully published that exact source as `borgmcp@2.0.2`; the registry records
integrity
`sha512-w0O0t/2wzeJpXEqb4jQGuqZeavEkfFKdz6poRT8q1TxDKHTlOlwo3auctE+X1kWU2s5JkSDcUiUdQdyLwu84IA==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
must use a fresh unused identity and requires the complete release gate again.

The annotated `v2.0.3` tag object
`47701127cbdba6499595ef0529de264b00a61840` peels to protected-main commit
`3e44e9c439c036850c6a9226d02876f4883501d9`. Workflow run `29851751102`
successfully published that exact source as `borgmcp@2.0.3`; the registry records
integrity
`sha512-3Iy4BSB+yq8F75w/gWiEU7D+mKCYYa5mIsn/iC/byy5CK/QsAWg10KgsBI3GlDBZul1CD3Qq+zpmVeK2qpIE1A==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
must use a fresh unused identity and requires the complete release gate again.

The annotated `v2.0.4` tag object
`f86c5b81b77afa7ebd080b508831f1dc39c403e2` peels to protected-main commit
`57a26139a11b47bc5f1d7234bc69e2a2a75954b3`. Workflow run `29925624599`, attempt 1,
successfully published that exact source as `borgmcp@2.0.4`; the registry records integrity
`sha512-xuGxMQ9FZTQN4KP/wGlJqI4LgxP2aKpeykbakjfXHPeUzmNHvkN0YtcenzlSvHsObnpQgMfsy7TNy+YrPkk65g==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
uses the unused `v2.0.5` identity from a fresh reviewed protected-main commit
and requires the complete release gate again.

The annotated `v2.0.5` tag object
`242ed67fec00701f4eb332302e60dff84c0368f7` peels to protected-main commit
`a18a169ec96c5e3194b3bd3edc9e84002c4bc7a3`. Workflow run `29955861508`, attempt 1,
successfully published that exact source as `borgmcp@2.0.5`; the registry records integrity
`sha512-pMqovKzUu0Mdru2YJULj3XkHSeiT/PuCAjwCQ2Sg/mmF299tZE80qvca6GCNCLjhYEWWIuXmssuxK7wePKqxdw==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
uses the unused `v2.0.6` identity from a fresh reviewed protected-main commit
and requires the complete release gate again.

The annotated `v2.0.6` tag object
`b41d312efc9f8d1ed63021812d8165b00011e8d8` peels to protected-main commit
`5fd9048e4c22e4478160e3a25654837b5a33d8bb`. Workflow run `29982288768`, attempt 1,
successfully published that exact source as `borgmcp@2.0.6`; the registry records integrity
`sha512-WDX4tmk46I6Tvb/Gz1XlD/9PbIgOe72rRDCjV+/lw6KnAxWW0S25LT1DgifotI9LQv7LLAok8WkjucDDTTQ+pw==`.
Never move, replace, reuse, or rerun that tag or workflow.

The annotated `v2.0.7` tag object
`bf41d5a70d7df11930a3124feda72835ae903522` peels to protected-main commit
`85f7c45cffdd449a6de4a52608453b6680492221`. Workflow run `30009042758`,
attempt 1, received registry metadata HTTP 504 for
`@esbuild/openbsd-arm64@0.28.1` and failed before package creation or npm
publication. The publish and registry-verification jobs were skipped, and
`borgmcp@2.0.7` remains absent from npm. Never delete, move, replace, reuse, or
rerun that tag, version, or workflow. The next candidate uses the unused
`v2.0.8` identity from a fresh reviewed protected-main commit and requires the
complete release gate again.

The annotated `v2.0.8` tag object
`7b5a4929534abfa97a65e278df230adfdb842d8f` peels to protected-main commit
`8bc796d8fc4e307dca593138fb080984662c7d62`. Workflow run `30012098601`, attempt 1,
successfully published that exact source as `borgmcp@2.0.8`; the registry records integrity
`sha512-az1IKG4VNwAF/8PKEVK88gdRoFFBqgtl6ObXX+CcJadavNqkwJ9UFeP8LOJ2js911mIiXEm8c4xDf6MnO0GOng==`.
Never move, replace, reuse, or rerun that tag or workflow. Its successor used
the fresh `v2.0.9` identity from a reviewed protected-main commit and passed the
complete release gate.

The annotated `v2.0.9` tag object
`3a88bb4f46143789803a4e57f52b94d762f1ca9b` peels to protected-main commit
`18084fc486a041f3438f584a97d218c01a5e0399`. Workflow run `30047299013`, attempt 1,
successfully published that exact source as `borgmcp@2.0.9`; the registry records integrity
`sha512-lf0TZ8ZcpHv/Nt3LkY/IGxkUFkg3weavF+rLv6xLImDDhLIaZly1y8jUdo3UuheQVhrLnLcxoz37Myr4mPx9lg==`.
Never move, replace, reuse, or rerun that tag or workflow.

The annotated `v2.0.10` tag object
`31ae3c19ac4e04fac33269459a460d5316cce730` peels to protected-main commit
`3f7003b65eadc74cd949857e831e1181a1aad2ff`. Workflow run `30063538271`, attempt 1,
successfully published that exact source as `borgmcp@2.0.10`; the registry records integrity
`sha512-BkFrq75mF7ih0/7Z7RsXsJYo43qNs4ng7tSnvcFCl3k6r+ex1FvTkah0+KQNinDSrv6a+HLWahUe8875so8zew==`.
Never move, replace, reuse, or rerun that tag or workflow. The next candidate
uses the unused `v2.0.11` identity from a fresh reviewed protected-main commit
and requires the complete release gate again.

## Release Prerequisites

The standalone client was extracted from private-monorepo commit
`17ff8ce14e12122a8cc9089f6b94174c02fa2a04` without importing its Git history.
Before creating the release tag, independently verify all of these conditions:

- the extraction review confirms no private backend secrets, deployment
  configuration, customer data, local state, or duplicated shared contracts
  entered the public package;
- the exact audited registry dependency `borgmcp-shared@0.6.2` remains locked to
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

Successful completion of `npm publish` is the terminal release boundary. There
is no post-publication registry readback job: registry metadata and install
visibility propagate asynchronously and cannot invalidate an immutable
publication after npm accepts it.

No separate checksum file is needed: the tarball verifier records canonical
SHA-512 SRI in the artifact report. GitHub's same-run artifact transport and the
report bind the reviewed candidate without repeated SHA512 choreography.

Rely on npm Trusted Publishing and provenance at publication time. Do not add a
post-publication registry readback, reconstruct DSSE, in-toto, SLSA,
workflow-ref, or builder statements locally.
Do not add cross-run tuple variables, cross-run artifact selection, duplicate
builds, duplicate package verification, checksum bundles, or SBOM ceremony.

## Stop And Recovery Conditions

Stop when source, settings, ownership, tag, artifact, test, audit, review, or
authorization evidence is missing or inconsistent. Never move or reuse a failed
tag, rerun a failed release workflow, overwrite an npm version, unpublish to hide
a failure, or substitute a local rebuild. Recovery starts from a fresh reviewed
source change and, after any registry mutation, a separately authorized version.
