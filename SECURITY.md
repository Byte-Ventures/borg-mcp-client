# Security Policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Byte-Ventures/borg-mcp-client/security/advisories/new). Do not disclose security issues in public issues.

Security fixes are supported on the latest reviewed client revision and, after publication, the latest published version. Reports should include affected versions, impact, reproduction steps, and suggested remediation. Avoid including live credentials or customer data.

GitHub Actions publishes only an immutable reviewed tag through the protected npm environment and Trusted Publishing. The workflow verifies exact registry integrity and runs `npm audit signatures` after publication.

## Local State Boundary

Local Borg state rejects static symlinks, non-directories, foreign ownership, and group/world-writable paths. It is designed for a single-user host. An actively malicious process already running as the same OS user can race pathname replacement after final identity checks; Node does not expose portable descriptor-relative filesystem operations to prevent that race, and that process already has direct authority over the user's local state.
