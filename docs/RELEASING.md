# Publishing `borgmcp`

The GitHub Actions workflow publishes one immutable, reviewed `borgmcp` version
from a protected annotated tag. The protected publish job uses npm Trusted
Publishing; no long-lived npm token is stored or exposed.

## Release Integrity

Release provenance is established by protected annotated tags, GitHub build
provenance, and npm Trusted Publishing. Tags and publication workflows are
immutable: never move, replace, reuse, or rerun them.

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
- the coupled client/server release is published only after the server artifact
  is rebuilt against `borgmcp-shared@0.11.0` and both pass the complete local
  dogfood gate;
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

### Clean-environment rig lifecycle

Every clean-environment verification rig has an explicit identity and an
explicit end-of-life. Run it from a Borg-launched session and keep filesystem
workspaces under the exact disposable scratch root Borg exports. Give each
workspace a name beginning with `borg-rig-` followed by its owner, purpose, and
a unique suffix. Before the first command that can create files, anchor the rig
as its own npm project:

```sh
BORG_SCRATCH_ROOT="${BORG_LAUNCH_SCRATCH:?run from a Borg-launched session}"
RIG_OWNER="$(basename "$BORG_SCRATCH_ROOT")"
RIG_NONCE="${RIG_NONCE:-$(date +%Y%m%d%H%M%S)-$$}"
RIG_ID="borg-rig-${RIG_OWNER}-release-${RIG_NONCE}"
RIG_ROOT="$BORG_SCRATCH_ROOT/$RIG_ID"
mkdir -p "$RIG_ROOT"
printf '%s\n' '{"private":true}' > "$RIG_ROOT/package.json"
```

The manifest anchor is required before any `npm install`, `npm update`, or
other npm command. Without it, npm can walk up from an empty scratch directory
and write the operator's `package.json` instead of creating project-local
state. In a source checkout, the committed `release:exercise` follows this rule
for its temporary consumer; other QA scripts and manual rigs must do the same.

The system temporary root is shared with the whole machine, so an unbounded
listing there is not an inspectable cleanup check. Bound that leg by the
invoking user and the run-window markers, which select directories whose
timestamps fall within this run window without requiring a prefix inventory.
New `mkdtemp` prefixes therefore require no documentation change. Keep both
time predicates and the ownership predicate: removing the run-window bound
turns a populated shared temp root back into an uninspectable listing.

On a machine where several runs share one user account, this listing can
include another run's live workspace. Removal is scoped to paths created by
this run; anything else in the output is reported, not deleted. Unrelated
same-user temporary directories created during the window can therefore
appear in the result, so never remove a path merely because this listing found
it.

```sh
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_OWNER="$(id -un)"
TEMP_SCAN_START="$TEMP_ROOT/.${RIG_ID}-temp-scan-start"
TEMP_SCAN_END="$TEMP_ROOT/.${RIG_ID}-temp-scan-end"

list_recent_owned_temp_rigs() {
  find "$TEMP_ROOT" -mindepth 1 -prune \
    -type d \
    -user "$TEMP_OWNER" \
    -newer "$TEMP_SCAN_START" \
    ! -newer "$TEMP_SCAN_END" \
    -print
}

touch "$TEMP_SCAN_START"
```

Container-backed rigs use the same `RIG_ID` as the container name and carry
both labels below. Register exact-target cleanup before launching the rig:

```sh
list_owned_rig_containers() {
  docker container ls --all \
    --filter label=borg-rig=1 \
    --filter "label=borg-rig-owner=${RIG_OWNER:?}" \
    --format '{{.ID}}\t{{.Names}}\t{{.Status}}'
}

cleanup_done=0
cleanup() {
  [ "$cleanup_done" -eq 0 ] || return
  cleanup_done=1
  trap - EXIT HUP INT TERM
  docker container rm --force "$RIG_ID" >/dev/null 2>&1 || true
  rm -rf -- "$RIG_ROOT"
  list_owned_rig_containers
  find "$BORG_SCRATCH_ROOT" -mindepth 1 -print
  find "$BORG_SCRATCH_ROOT" -name 'borg-rig-*' -print
  if [ -e "$TEMP_SCAN_START" ]; then
    touch "$TEMP_SCAN_END"
    list_recent_owned_temp_rigs
  fi
  rm -f -- "$TEMP_SCAN_START" "$TEMP_SCAN_END"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
```

List containers and scratch paths before starting. The filters distinguish this
session's rigs from unrelated containers on a shared host:

```sh
list_owned_rig_containers
find "$BORG_SCRATCH_ROOT" -mindepth 1 -print
find "$BORG_SCRATCH_ROOT" -name 'borg-rig-*' -print
```

Only after the cleanup traps and pre-launch listings are in place, launch a
container-backed rig. `--rm` is preferred; a runtime without automatic removal
must remove the exact `RIG_ID` in its cleanup path and retain the labels for a
bounded sweep:

```sh
RIG_IMAGE="${RIG_IMAGE:?set the rig image}"
docker run --rm \
  --name "$RIG_ID" \
  --label borg-rig=1 \
  --label "borg-rig-owner=$RIG_OWNER" \
  "$RIG_IMAGE"
```

The unfiltered filesystem listings expose legacy names as well as conforming
rigs. The bounded temporary-directory function reports same-user directories
created during the run window, including unrelated work; it does not establish
which process owns them. The cleanup path runs the container and scratch
listings after removing this rig, then runs the bounded temporary-directory
listing between the start and end markers. Inspect and report its results. If a
rig creates an exact system-temporary path, record that path when it is created
and remove that exact path during cleanup; never remove a path solely because
the bounded listing found it.

Register cleanup before launching any process, run it on success and failure,
and do not deliver a verdict until the container listing and both scratch
listings show no rig owned by this run, every exact system-temporary path
recorded by the rig has been removed, and the bounded temporary-directory
listing has been inspected and reported. For a non-`--rm` container runtime,
remove only the named rig or the same owner label; never prune unrelated
containers. A completed verification
therefore implies zero running or stopped rig containers and no rig workspace
created by this run left in either the session scratch root or any exact
system-temporary path the rig recorded.

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

After `verify` succeeds, the designated Queen operator alone approves the
`npm-publish` environment. There is no separate pre-publication exact-artifact
Security gate: the verify job is the mechanical authority for the exact bytes
that the publish job consumes. Environment approval authorizes publication; it
does not permit a rerun, a rebuilt artifact, or approval by another actor.

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

Separately, once the release is installable from the canonical registry, install
it into an isolated prefix and exercise the real user update path end to end.
This is product verification, not publication validation: failure routes a new
reviewed fix and never invalidates, rebuilds, retags, or reruns the immutable
release. Do not repeat byte comparisons, integrity/SRI checks, packed-version
checks, source-tree verification, dist-tag readback, or provenance readback that
the exact-artifact `verify` and publish jobs already completed.

No separate checksum file is needed: the tarball verifier records canonical
SHA-512 SRI in the artifact report. GitHub's same-run artifact transport and the
report bind the reviewed candidate without repeated SHA512 choreography.

Rely on npm Trusted Publishing. Do not perform post-publication provenance
readback or reconstruct DSSE, in-toto, SLSA, workflow-ref, or builder statements
locally.
Do not add cross-run tuple variables, cross-run artifact selection, duplicate
builds, duplicate package verification, checksum bundles, or SBOM ceremony.

## Stop And Recovery Conditions

Stop when source, settings, ownership, tag, artifact, test, audit, review, or
authorization evidence is missing or inconsistent. Never move or reuse a failed
tag, rerun a failed release workflow, overwrite an npm version, unpublish to hide
a failure, or substitute a local rebuild. Recovery starts from a fresh reviewed
source change and, after any registry mutation, a separately authorized version.
