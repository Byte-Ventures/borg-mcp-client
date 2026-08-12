# Security Policy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Byte-Ventures/borg-mcp-client/security/advisories/new). Do not disclose security issues in public issues.

Security fixes are supported on the latest reviewed client revision and, after publication, the latest published version. Reports should include affected versions, impact, reproduction steps, and suggested remediation. Avoid including live credentials or customer data.

GitHub Actions submits only an immutable reviewed tag to npm staged publishing through the protected npm environment and Trusted Publishing. Workflow success means npm accepted the private stage, not that the version is live. The terminal release boundary is interactive stage approval followed by canonical registry visibility and integrity verification.
