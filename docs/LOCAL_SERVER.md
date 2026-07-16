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
exact tuple as `PENDING` in the operating-system keychain. An ambiguous exchange
retries that tuple exactly; the credential becomes active only after the
versioned response is decoded and the authenticated protocol handshake succeeds.
There is no file fallback. A new process resumes that pending enrollment before
displaying another invitation prompt.

`--cube-name <name>` explicitly selects the repository cube name. Without an
explicit name, Borg uses the `origin` repository name or, when `origin` is
absent, proposes the sanitized repository-directory basename before consuming
an enrollment invitation. Confirm interactively or pass `--yes`; bare
repositories fail closed.

The connection is HTTPS-only. Borg validates the server trust material, stores
enrollment and session credentials in the operating-system keychain, and
persists only an opaque credential reference with the active cube. Local requests
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

An identical `--here` rerun validates the saved keychained seat and reattaches
with its durable retry tuple instead of choosing another role and minting a new
drone. Ambiguous liveness or transport results never authorize a replacement;
only an authoritative eviction rotates the retry tuple and permits a remint.

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Recovery commands

- No saved or rejected enrollment: rerun `borg assimilate --host <server> --enroll`
  from the operator's interactive terminal.
- Rejected or expired invitation: stop the server; use
  `borg-mcp-server owner-invite` for an unclaimed owner client or
  `borg-mcp-server client-invite` for an ordinary client; restart the server and
  rerun the enrollment command with the replacement enrollment invitation.
- Unreachable server: start or restart it with `borg-mcp-server start`, then
  rerun `borg assimilate --host <server>`.
- Trust mismatch after an intentional server re-initialization: verify the
  expected server identity, stop and restart `borg-mcp-server start`, then retry.
- Busy or unavailable keychain: wait for the other Borg process or unlock the OS
  keychain, then rerun the same command.
- Unusable project name: rerun with `--cube-name <name>`.
- Incompatible response: verify compatible client and server versions, then
  retry the same endpoint.

## Release Blockers

This WIP consumes the exact audited `borgmcp-shared@0.3.0` registry release.
The matching server #5 owner-enrollment,
cube-create, attach, restart, log, and SSE implementation must also pass the
full process-level local dogfood gate. Until then this path remains preview-only.
