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
- the exact audited registry dependency `borgmcp-shared@0.11.0` remains locked to
  its canonical tarball and integrity
  `sha512-I8mixCbSrLKyOAAyqEI/HZJ8cML2rz3r812Up8pr547OdAk9LxZevdCo7ojG42ZwrUmS5u7iKQPg7Vk1XvtX1g==`;
- the coupled shared/server/client candidates have all been built against the
  same exact `borgmcp-shared` version and passed the complete local dogfood gate
  before any stage is approved;
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

### Release branches

Release branches use the `release/` prefix and enter protected `main` through a
pull request. Direct pushes only update staging branches; publication still
requires the complete protected release gate.

## Repository Controls

Repository settings are operator-owned and are not changed by this workflow.
Before preparing a candidate, independently verify:

1. The `npm-publish` environment disables administrator bypass, requires the
   reviewed human approver, and allows only the protected release refs. Its
   `NPM_EXPECTED_OWNER` variable must match the sole reviewed maintainer of the
   existing `borgmcp` package. It must contain no npm token.
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

### Pre-tag composed exercise

Before creating a release tag, exercise the packed client against the selected
server artifact:

```sh
npm run release:exercise -- \
  --server /absolute/path/to/borgmcp-server.tgz \
  --server-integrity 'sha512-...'
```

The server integrity must come from the reviewed producer of that artifact. Run
the command once with the published counterpart. When the client and server are
being released together, run it again with the co-releasing server candidate.
The default path builds and packs the current client; `--client-tarball` exists
only for reproducing a reviewed packed client or running a negative control.

This harness exercises reviewed release candidates and their published
counterparts. It is not a containment sandbox for hostile or otherwise untrusted
packages and must not be used as one. The temporary install and data directories
isolate the reviewed exercise from normal product state; they are not an
operating-system security boundary.

The harness requires Node.js 22, npm 11.18.0, Python 3, and macOS or Linux. It
installs both tarballs into a private temporary project, bootstraps isolated
server data, and starts the installed server directly. It never uses
`borg server setup`, because registry-backed activation would select the
previously published server instead of a candidate.

Both composed terminal journeys run under a real PTY:

- `borg server dashboard` must render the attached-viewer footer, exit cleanly
  on Ctrl-C, restore the cursor and alternate screen, and leave the server's
  pinned-TLS process healthy at `GET /healthz` (204, empty body).
- `borg server start` must render the foreground-server footer, exit cleanly on
  Ctrl-C, restore the terminal, stop the server, and release its health endpoint.

The client facade resolves `borg-mcp-server` by bare name. The harness therefore
uses a controlled shim only to arrange resolution, then verifies the outcome:
before trusting a frame, it reads the live process command and requires the
absolute installed server entry. Every client or server executable must resolve
inside the installed package root covered by the SRI cited for that role. Its
JSON report records the absolute path, version, and independently supplied
integrity for the client, dashboard listener, dashboard viewer, and foreground
listener/viewer roles. PATH ordering alone is never accepted as identity evidence.

The harness is a fail-closed release gate. A missing frame, non-PTY execution,
wrong journey footer, substituted artifact, nonzero exit, absent terminal
restore sequence, failed post-exit health assertion, timeout, or oversized
transcript fails the command. Its controls must remain demonstrably bidirectional:
the current client/server pairing passes; and a deliberately wrong server
integrity fails before either journey starts.

The terminal-restore negative control is specifically the packed pre-#146 client
from commit `81da7b970ffb4e76a35c7bc551c419fec702a3b6` composed with published
`borgmcp-server@0.2.0`, registry integrity
`sha512-squb0+vdy0q7l/4FeV7OTvSm7OiFWGsAjGhcVEXYrQc9K/8jJYduqPS90VBwaJRT6z221Gxf3xQ5SeZe/Qoncw==`.
That composition must fail on the missing cursor-restore sequence. A newer server
candidate can mask the old client's defect and is not a valid counterpart for
this negative control.

```sh
npm run release:exercise -- \
  --server borgmcp-server@0.2.0 \
  --server-integrity 'sha512-squb0+vdy0q7l/4FeV7OTvSm7OiFWGsAjGhcVEXYrQc9K/8jJYduqPS90VBwaJRT6z221Gxf3xQ5SeZe/Qoncw==' \
  --client-tarball /absolute/path/to/pre-146-borgmcp-2.1.1.tgz
```

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

After `verify` succeeds, the designated Queen operator alone approves the
`npm-publish` environment. There is no separate pre-stage exact-artifact
Security gate: the verify job is the mechanical authority for the exact bytes
that the stage job consumes. Environment approval authorizes submitting those
bytes to npm's private staged-publishing service; it does not make the version
public or authorize approval by another actor.

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

The authorized operator approves the verified stages. Confirm canonical live
package visibility and integrity before announcing the release or updating
dependent packages.

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

Stop when source, settings, ownership, tag, artifact, test, audit, review, or
authorization evidence is missing or inconsistent. Never move or reuse a tag,
overwrite an npm version, unpublish to hide a failure, or substitute a local
rebuild. A pre-stage workflow failure may be rerun against the same immutable
tag. After npm accepts a stage, recovery uses a fresh reviewed version.
