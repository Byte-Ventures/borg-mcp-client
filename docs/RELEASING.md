# Publishing `borgmcp`

The GitHub Actions workflow submits one immutable, reviewed `borgmcp` tarball to
npm staged publishing from a protected annotated tag. A designated operator
later approves that stage to make the version live. The protected stage job uses
npm Trusted Publishing; no long-lived npm token is stored or exposed.

## Release Integrity

Release provenance is established by protected annotated tags, GitHub build
provenance, and npm Trusted Publishing. Never move, replace, or reuse a tag.
A failed workflow may be rerun until npm accepts a stage; stage acceptance
consumes the version.

## Release Prerequisites

The standalone client was extracted from private-monorepo commit
`17ff8ce14e12122a8cc9089f6b94174c02fa2a04` without importing its Git history.
Before creating the release tag, independently verify all of these conditions:

- the extraction review confirms no private backend secrets, deployment
  configuration, customer data, local state, or duplicated shared contracts
  entered the public package;
- the exact audited registry dependency `borgmcp-shared@1.0.0` remains locked to
  its canonical tarball and integrity
  `sha512-c55kxgfpo3GWXQB2pxy65CV4zjgoWRLZKidVfdR7/k8kKX9m5cqV7gUckUJ15BuvkIGrha5PFO7NAz5xPUXaeQ==`;
- the current published server and the client candidate use the same exact
  `borgmcp-shared` version; publish a compatible server before tagging the
  client when that pin changes;
- the compatible registry release is `borgmcp-server@1.0.0` with integrity
  `sha512-JRIrGLek0Ey/E9zfoiBNZYIAaGLcaWTsbTbR005KVU2OIbNrFg/mTU0Vbexw3iJoL/AGSZmARLVxfgO+CNOhBQ==`;
- the selected stable client version is unused and the exact release commit is
  on protected `main`;
- the repository and protected npm environment settings pass an operator audit;
- the exact release source passes exact-SHA CI and one Code Review.

`scripts/verify-release-readiness.mjs` makes the source-side blockers
machine-checkable and compares the client pin with the current published server.
A release tag created before they are resolved fails before dependency
installation or publication.

### Release branches

Release branches use the `release/` prefix and enter protected `main` through a
pull request. After exact-SHA CI and one Code Review, merge the preparation and
create its annotated version tag. The tag automatically verifies and stages the
package.

## Repository Controls

Repository settings are operator-owned and are not changed by this workflow.
Before preparing a candidate, independently verify:

1. The `npm-publish` environment disables administrator bypass, has no required
   reviewer, and allows only `v*.*.*` tags. Its `NPM_EXPECTED_OWNER` variable
   must match the sole reviewed maintainer of the existing `borgmcp` package.
   It must contain no npm token.
2. npm Trusted Publishing is configured for organization `Byte-Ventures`,
   repository `borg-mcp-client`, workflow `publish.yml`, and environment
   `npm-publish`. Its allowed actions enable `npm stage publish` and disable
   direct `npm publish`; package publishing requires two-factor authentication
   and disallows tokens.
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
dispatch is intentionally absent. The workflow rejects root `.npmrc`
configuration, non-tag events, lightweight or malformed tags, version mismatch,
source/tag mismatch, and tags whose commits are not on protected `main`.

The unprivileged `verify` job performs one sequence:

1. Verify the public-source boundary, extraction readiness, exact shared-package
   pin, and canonical registry lock metadata.
2. Install the lockfile once with lifecycle scripts disabled and audit it.
3. Run one readable build and reject generated `dist` drift. Tests already ran
   in CI on the exact source.
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
request context, rejects a legacy `NODE_AUTH_TOKEN`, and stages the exact tarball
path once with lifecycle scripts disabled and provenance enabled. It
does not install project dependencies, rebuild, retest, repack, or reverify the
package.

Successful completion of the workflow means npm accepted the immutable staged
tarball. It does not mean the version is public. Stage acceptance consumes the
version, but must not trigger
release announcements, issue closure, consumer pins, site synchronization, or
claims that the version was published. There is no workflow registry readback:
stage inspection and approval require an interactive npm identity and cannot use
the workflow's OIDC credential.

Inspect the npm stage, then approve it interactively. This stage approval is the
sole human publication boundary. Confirm canonical live package visibility and
integrity before announcing the release or updating dependent packages.

After all three packages cross that boundary, create their GitHub Releases in
the same shared → server → client operator session. In each package repository,
run:

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/create-github-release.mjs <version>
```

The script binds the annotated tag, live npm package and integrity, and Release
absence before creating the Release. It reads
the curated `docs/releases/<version>.md` notes from the exact tagged commit,
renders them under `News and fixes`, and refuses missing or blank notes and an
existing Release.

## Stop And Recovery Conditions

Stop when source, settings, ownership, tag, artifact, test, audit, or review
evidence is missing or inconsistent. Never move or reuse a tag,
overwrite an npm version, unpublish to hide a failure, or substitute a local
rebuild. A pre-stage workflow failure may be rerun against the same immutable
tag. After npm accepts a stage, recovery uses a fresh reviewed version.
