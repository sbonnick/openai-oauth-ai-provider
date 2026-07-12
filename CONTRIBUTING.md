# Contributing

## Development

Use Node.js 24 or newer and install the exact dependency graph:

```sh
npm ci
npm run check
npm run build
```

`npm run check` formats, lints, type-checks, runs deterministic mocked tests,
and verifies the packed package from a temporary consumer.

## Pull requests

- Keep changes focused and add deterministic tests for changed behavior.
- Never commit or paste live OAuth credentials, token files, or unredacted
  authenticated requests.
- Use injected `fetch`, time, and token stores rather than live services.
- Update public exports and README examples when changing public behavior.
- Call out compatibility assumptions copied from Codex or upstream adapters.
- Confirm `npm run check` and `npm run build` pass.

Examples can authenticate, contact external services, and consume account
quota. Do not run them in routine tests. A live smoke test requires an
authorized account and an explicit reason.

By contributing, you agree that your contribution is licensed under the MIT
License. No contributor license agreement is currently required.
