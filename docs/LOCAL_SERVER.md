# Self-Hosted Server

The client can attach to an explicitly selected `borgmcp-server` authority:

```bash
borg assimilate --host 127.0.0.1:7091 --enroll
```

The connection is HTTPS-only. Borg validates the server trust material, stores enrollment and session credentials in the operating-system keychain, and persists only an opaque credential reference with the active cube. Local requests use the server's `/api/cubes/*` coordination routes and do not fall back to Google OAuth or Borg Cloud.

The current client does not install or start `borgmcp-server`. The server must already be running, trusted, and provisioned with a cube, role, and client grant. Local cube creation and Cloud-only capabilities fail explicitly rather than being redirected.

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Enrollment Blocker

The existing server-generated local enrollment bearer response is not the final dogfood contract. Before release, the client must generate the bearer and retry key locally, persist a `PENDING` keychain record before network I/O, retry the exact tuple after an ambiguous response, and activate it only after a verified response. Local enrollment must never fall back to file storage. That protocol redesign requires a separately reviewed shared contract and is intentionally not folded into this extraction.
