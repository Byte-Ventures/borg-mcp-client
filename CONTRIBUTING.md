# Contributing

Use Node.js 22.22.2 and npm 11.18.0. Install and verify from the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run onboarding:smoke
```

Pull requests should remain client-only, include tests for behavioral changes, and keep generated `dist/` output synchronized with `src/`. Do not add Git, local-path, or lifecycle-script dependencies. Report defects through the [borg-mcp-client issue tracker](https://github.com/Byte-Ventures/borg-mcp-client/issues).

Release controls are documented in [`docs/RELEASING.md`](docs/RELEASING.md).
