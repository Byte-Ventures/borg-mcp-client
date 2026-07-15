# Self-Hosted Server

The extracted client contains a held integration path for attaching to an
explicitly selected `borgmcp-server` authority. It is available for protocol
development and review, not supported dogfood or release onboarding:

```bash
borg assimilate --host 127.0.0.1:7091
```

`--host --enroll` exercises the existing held enrollment protocol through a
hidden invitation prompt. It does not complete the approved local onboarding
design and must not be presented as release-ready.

The connection is HTTPS-only. Borg validates the server trust material, stores enrollment and session credentials in the operating-system keychain, and persists only an opaque credential reference with the active cube. Local requests use the server's `/api/cubes/*` coordination routes and do not fall back to Google OAuth or Borg Cloud.

The current client does not install or start `borgmcp-server`. The server must already be running, trusted, and provisioned with a cube, role, and client grant. `--host` cannot create a cube. Local cube creation and Cloud-only capabilities fail explicitly rather than being redirected.

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Enrollment Blocker

The existing server-generated local enrollment bearer response is not the final dogfood contract. Before release, the client must generate the bearer and retry key locally, persist a `PENDING` keychain record before network I/O, retry the exact tuple after an ambiguous response, and activate it only after a verified response. Local enrollment must never fall back to file storage. That protocol redesign requires a separately reviewed shared contract and is intentionally not folded into this extraction.
