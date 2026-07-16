# Self-Hosted Server

The extracted client contains a work-in-progress path for enrolling with and
attaching to an explicitly selected `borgmcp-server` authority. It is available
for protocol development and review, not supported release onboarding:

```bash
borg assimilate --host 127.0.0.1:7091
```

`--host --enroll` reads the invitation from a hidden prompt. Before sending it,
the client generates a 256-bit credential and UUID retry key and persists the
exact tuple as `PENDING` in the operating-system keychain. An ambiguous exchange
retries that tuple exactly; the credential becomes active only after the
versioned response is decoded and the authenticated protocol handshake succeeds.
There is no file fallback.

`--cube-name <name>` explicitly selects the repository cube name. Without an
explicit name, Borg uses the `origin` repository name or, when `origin` is
absent, proposes the sanitized repository-directory basename before consuming
an enrollment invitation. Confirm interactively or pass `--yes`; bare
repositories fail closed.

The connection is HTTPS-only. Borg validates the server trust material, stores enrollment and session credentials in the operating-system keychain, and persists only an opaque credential reference with the active cube. Local requests use the server's `/api/cubes/*` coordination routes and do not fall back to Google OAuth or Borg Cloud.

The current client does not install or start `borgmcp-server`. The server must
already be running and trusted. An owner enrollment carrying the persisted
`create_cube` capability creates one idempotent cube per repository during
normal assimilation, using the server-owned `default` role template; repeating
an ambiguous request does not duplicate the cube, and distinct repositories can
create distinct bounded cubes. An ordinary enrolled client is denied before a
create request is sent. Cloud-only capabilities fail explicitly rather than
being redirected.

An identical `--here` rerun validates the saved keychained seat and reattaches
with its durable retry tuple instead of choosing another role and minting a new
drone. Ambiguous liveness or transport results never authorize a replacement;
only an authoritative eviction rotates the retry tuple and permits a remint.

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Release Blockers

This WIP consumes the exact audited `borgmcp-shared@0.3.0` registry release.
The matching server #5 owner-enrollment,
cube-create, attach, restart, log, and SSE implementation must also pass the
full process-level local dogfood gate. Until then this path remains preview-only.
