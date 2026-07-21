# Self-Hosted Server

Install and initialize the server in the human operator's terminal:

```bash
npm install -g borgmcp-server
borg-mcp-server setup
borg-mcp-server start
```

Keep the server running. Open a second operator terminal in the project checkout
and run:

```bash
borg assimilate --host 127.0.0.1:7091 --enroll
```

The labeled hidden prompt awaits the owner enrollment invitation (single-use,
shown once). An owner enrollment invitation comes from setup or the offline
`borg-mcp-server owner-invite` recovery command. A later ordinary client uses a
client enrollment invitation from `borg-mcp-server client-invite`. Never put an
enrollment invitation in argv, environment variables, logs, or diagnostics.
The offline replacement commands visibly prompt for the recovery credential;
never put that credential in argv or environment variables either.

Before sending the invitation,
the client generates a 256-bit credential and UUID retry key and persists the
exact tuple as `PENDING` in the local seat store on this machine — a
0600-permission file store, parity with the server's TLS keys. An ambiguous
exchange retries that tuple exactly; the credential becomes active only after the
versioned response is decoded and the authenticated protocol handshake succeeds.
A new process resumes that pending enrollment before displaying another
invitation prompt.

`--cube-name <name>` explicitly selects the repository cube name. Without an
explicit name, Borg uses the `origin` repository name or, when `origin` is
absent, proposes the sanitized repository-directory basename before consuming
an enrollment invitation. Confirm interactively or pass `--yes`; bare
repositories fail closed.

The connection is HTTPS-only. Borg validates the server trust material, stores
enrollment and session credentials in the local seat store on this machine (a
0600-permission file store), and persists only an opaque credential reference
with the active cube. Local requests
use the server's `/api/cubes/*` coordination routes. They cannot use hosted OAuth
credentials or change authority implicitly.

The current client does not install or start `borgmcp-server`. The server must
already be running and trusted. An owner enrollment carrying the persisted
`create_cube` capability creates one idempotent cube per repository during
normal assimilation, using the server-owned `default` role template; repeating
an ambiguous request does not duplicate the cube, and distinct repositories can
create distinct bounded cubes. An ordinary enrolled client is denied before a
create request is sent. Cloud-only capabilities fail explicitly rather than
being redirected.

After the first attach, the launched agent should run `borg_whoami` and
`borg_roster` to verify its seat and begin coordinating. To create a second seat,
the operator runs the explicit local assimilation command from the intended
worktree. A fresh worktree operation creates a distinct drone; an ambiguous
retry of that same operation resumes the same drone.

An identical `--here` rerun validates the saved local seat and reattaches by
re-sending the same client-generated session bearer — the sole server correlator —
instead of choosing another role or minting a new drone. The bearer is REUSED, not
rotated: the server binds only its digest, so a re-sent identical bearer resolves to
the existing seat. Ambiguous liveness or transport results never authorize a
replacement; only an authoritative eviction mints a fresh bearer and permits a
remint. (The `retry_key` idempotency key applies to enrollment and cube-creation
only — never to seat re-attach, which is idempotent through the bearer itself.)

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Recovery commands

- No saved or rejected enrollment: rerun `borg assimilate --host <server> --enroll`
  from the operator's interactive terminal.
- Rejected or expired invitation: keep the server running and mint a replacement
  scoped invitation with `borg-mcp-server owner-invite` for an unclaimed owner
  client or `borg-mcp-server client-invite` for an ordinary client, then rerun
  `borg assimilate --host <server> --enroll` with the replacement invitation.
- Rejected or unloadable local seat: run `borg reset-local-seat --host <server>`
  to clear ONLY this worktree's saved local seat, then — with the server still
  running — ask the operator for a fresh scoped invitation and rerun
  `borg assimilate --host <server> --enroll`.
- Unreachable server: start or restart it with `borg-mcp-server start`, then
  rerun `borg assimilate --host <server>`.
- Trust mismatch after an intentional server re-initialization: verify the
  expected server identity, stop and restart `borg-mcp-server start`, then retry.
- Busy local seat store: wait for the other Borg process to finish, then rerun
  the same command. If the local seat store cannot be read or written, ensure its
  directory on this machine is readable and writable, then rerun.
- Unusable project name: rerun with `--cube-name <name>`.
- Incompatible response: verify compatible client and server versions, then
  retry the same endpoint.

## Release status

This self-hosted path consumes the published `borgmcp-shared@0.4.3` v2 registry
release. The matching server owner-enrollment, cube-create, attach, restart, log,
and SSE implementation must also pass the full process-level local dogfood gate.
Until that gate opens the self-hosted path remains preview-only, and the client
publish is deferred accordingly.
