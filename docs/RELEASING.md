# Publishing `borgmcp`

This repository publishes immutable public releases from a protected GitHub
Actions environment. The workflow builds one tarball, exposes that exact
artifact for Security review, and publishes only the reviewed bytes. This
runbook is an operator procedure; it does not authorize a tag or publication.

## Current Release Blockers

The repository is an extraction scaffold. A release remains blocked until all
of these conditions are independently reviewed and satisfied:

- the complete client source, tests, package metadata, lockfile, public
  documentation, `SECURITY.md`, and `CONTRIBUTING.md` have been extracted;
- the extraction review confirms no private backend, credentials, deployment
  configuration, customer data, local state, or duplicated shared contracts
  entered the public package;
- `borgmcp-shared` has been published and cryptographically verified, and the
  client depends on registry package `borgmcp-shared@^0.2.0` with one canonical
  lockfile resolution and SHA-512 integrity;
- the client package passes its full tests, type checks, build, clean packed
  installation, MCP stdio, and local-server/Cloud compatibility gates;
- the repository is public and the settings below pass an operator audit; and
- the exact release commit has the required Code Review, Security, Release
  Quality, extraction, and explicit release-authorization gates.

`scripts/verify-release-readiness.mjs` makes the source-side blockers
machine-checkable. A release tag created before they are resolved fails before
dependency installation or artifact creation.

## Required Repository Configuration

Configure and independently verify these controls before creating a release
tag. Repository settings are operator-owned; source changes do not apply them.

1. Create an `npm-publish` environment. Disable administrator bypass and
   require the reviewer set ratified for client releases. Restrict deployment
   branches to protected tags matching `v*.*.*`. Add environment variable
   `NPM_EXPECTED_OWNER` only after comparing it with the live maintainers of the
   existing `borgmcp` npm package. Store no long-lived npm token: client
   releases use npm Trusted Publishing through OIDC.
2. Configure npm Trusted Publishing for organization `Byte-Ventures`,
   repository `borg-mcp-client`, workflow `publish.yml`, and environment
   `npm-publish`. Do not assume package control from the repository name;
   verify the authenticated npm account and the live package maintainers first.
3. Protect `refs/tags/v*.*.*` from unauthorized creation, update, deletion, and
   non-fast-forward changes. Releases require annotated tags whose commits are
   on protected `main`. Never move, reuse, or rerun a failed release tag.
4. Protect `main` from deletion and non-fast-forward updates. Require resolved
   review threads and the repository CI checks with strict status checking.
   Keep integration through reviewed pull requests; do not add a bypass that
   silently defeats the cube review gates.
5. Restrict Actions to the pinned GitHub-owned actions present in this
   repository. Require full commit-SHA pins. Keep the default workflow token
   read-only and prevent Actions from approving pull requests.
6. Enable private vulnerability reporting, secret scanning, push protection,
   and Dependabot security updates. Enable validity checks and non-provider
   patterns when the organization plan supports them.

Both jobs reject a checked-out root `.npmrc` immediately after checkout and
before `setup-node` or any npm command. The exact npm bootstrap then uses an
isolated user config, cache, and prefix, forces `https://registry.npmjs.org`,
disables scripts, and asserts both npm version and active registry. Runner-owned
npm configuration created later is distinct from untrusted repository config.

Current verified control-plane snapshot: the repository is public; secret
scanning, push protection, Dependabot, and CodeQL are enabled; Actions permits
only GitHub-owned actions with mandatory full-SHA pins, a read-only default
token, and no pull-request approval; and active rulesets protect `main` and make
`v*.*.*` tags immutable with Queen-only bypass. The `npm-publish` environment
and npm Trusted Publisher remain outstanding and gated until this source
workflow is approved. The Coordinator must execute and verify those remaining
controls under decision `client-server-release-lanes-autonomy` without treating
that decision as tag or publication authorization.

## Source And Tag Gate

The only publishing trigger is a protected annotated `v<package version>` tag.
The manual workflow input is verification-only and must be dispatched from
protected `main`; it can never enter the publish environment. In both paths the
workflow independently fetches the remote annotated tag into an isolated ref,
binds its peeled commit to the checked-out source, proves main ancestry, and
requires `GITHUB_RUN_ATTEMPT=1`. GitHub Actions reruns of a failed release or
verification attempt fail closed; recovery starts from reviewed source and a
newly authorized version/tag rather than reusing the old run.

Before creating a tag:

1. Fetch the current protected `main` and verify the intended commit and package
   version.
2. Run the complete project gates and `node scripts/verify-release-readiness.mjs`.
3. Verify `npm view borgmcp maintainers --json` against the reviewed expected
   owner and confirm the target version does not exist.
4. Confirm Trusted Publishing, environment protection, Actions restrictions,
   tag/main protections, security settings, and all required gates against live
   control-plane surfaces.
5. Obtain explicit authorization for the exact version, commit, and annotated
   tag. Release-lane setup authorization is not release authorization.

## Exact Artifact Gate

The unprivileged `verify` job installs locked dependencies with lifecycle
scripts disabled, audits dependencies, runs project gates, rebuilds readable
tracked output, and rejects drift. It then creates one npm tarball and enforces:

- public-file and file-type allowlists, size/count bounds, and path safety;
- canonical Apache-2.0 `LICENSE` and the approved `NOTICE` attribution;
- readable TypeScript source, source maps whose targets are shipped, executable
  CLI bins, and no consumer lifecycle hooks;
- no credentials, keys, private service URLs, database URLs, local paths,
  `.npmrc`, environment files, symlinks, or special archive entries;
- exact `borgmcp` identity and public provenance repository; and
- registry-only dependencies with `borgmcp-shared@^0.2.0`.

Every lock entry is bound to its package-path identity, version, exact canonical
npm tarball URL, and full SHA-512 SRI. The release gate fetches official
name/version metadata from the canonical registry and compares both tarball URL
and integrity for every entry, including duplicates and platform-skipped
optional packages.

The workflow records the tarball SHA-512 and uses an explicit filesystem path
for npm dry-run/publish. Bare `release/<file>.tgz` package specs are forbidden:
npm may parse them as GitHub shorthand instead of local files.

Before upload, the workflow globally installs that exact tarball with lifecycle
scripts disabled into an isolated temporary prefix, requires a clean production
dependency tree, imports the shipped root export, launches npm's generated
`borg-mcp` bin shim, and requires successful MCP initialization plus non-empty
tool discovery over stdio. Non-JSON stdout, missing exports, broken shebang/bin
mapping, missing runtime files/dependencies, startup failure, timeout, or empty
tool discovery blocks the release.

Security must download and approve the exact workflow artifact. The protected
environment must remain pending until that approval and separate release
authorization exist. The publish job downloads the same bytes, verifies the
checksum and artifact again, proves package ownership and version availability,
and publishes that tarball with OIDC provenance. No local rebuild may replace
it.

## Post-Publish Verification

Before changing any consumer or announcing a release, require all workflow
checks to pass:

- registry `dist.integrity` equals the audited tarball integrity;
- the sole reviewed maintainer set is unchanged;
- the signed in-toto/SLSA statement binds package, version, SHA-512 digest,
  repository, workflow, protected tag, push event, commit, and GitHub-hosted
  builder; and
- `npm audit signatures` verifies registry signatures and attestations from a
  clean install.

If npm accepted a version but any integrity, ownership, or provenance check
fails, block all consumer migration and treat it as a release incident.

## Stop And Recovery Conditions

Stop without approving the environment when any source, settings, ownership,
tag, artifact, test, audit, review, or authorization claim cannot be verified.
Versions and release tags are immutable evidence. Never force-push, move a tag,
rerun a failed tag workflow, overwrite a package version, unpublish to hide a
failure, or publish a local rebuild. Recovery requires a fresh reviewed source
fix and a separately authorized new version and annotated tag.
