# AGENTS.md

## Purpose and scope

This repository is a Node.js ESM TypeScript library that authenticates a user with the ChatGPT/Codex device-code flow and adapts the ChatGPT Codex Responses backend for AI SDK 7 and TanStack AI. These instructions apply to the entire repository.

The backend at `https://chatgpt.com/backend-api/codex` is not the public OpenAI Platform API. Treat behavior copied from the open-source Codex client and behavior inherited from SDK provider packages as unstable integration contracts. Prefer small, well-tested compatibility changes over speculative abstractions.

## Repository map

- `src/auth.ts`: device authorization, polling, OAuth exchange, proactive refresh, refresh deduplication, and in-process token caching.
- `src/store.ts`: token schema plus memory and atomic file stores. The file contains secrets.
- `src/jwt.ts`: unverified JWT decoding used only for routing and expiry metadata.
- `src/authenticated-fetch.ts`: request header enforcement and the single refresh/retry on HTTP 401.
- `src/provider.ts`: AI SDK Provider V4 wrapper. It forces the stream-only Codex contract and collects streams for `doGenerate`.
- `src/collect-stream.ts`: converts Provider V4 stream parts into a generation result.
- `src/tanstack.ts`: TanStack adapter wrapper and Codex-specific request defaults.
- `src/constants.ts`, `src/errors.ts`: shared protocol values and stable typed errors.
- `src/index.ts`: the package's public API. A symbol is not public until it is intentionally exported here.
- `tests/`: offline integration-style tests using mocked fetch and synthetic SSE/JWT data.
- `examples/`: credentialed executable examples; these can contact real authentication and model endpoints.
- `README.md`: user-facing contract, limitations, setup, and examples.
- `dist/`, `.test-dist/`, `.examples-dist/`: generated output; never edit or commit these directories.

## Runtime and tooling

- Use Node.js 22.18 or newer and npm. The package is ESM (`"type": "module"`).
- Install exactly from the lockfile with `npm ci`.
- Keep source imports compatible with `NodeNext`: relative TypeScript imports use the emitted `.js` suffix, for example `./auth.js`.
- TypeScript is intentionally strict, including `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, unused checks, and declaration generation.
- Biome owns formatting, linting, and import organization. Use single quotes and semicolons; do not hand-format against Biome.

## Required workflow

Before editing, read the relevant implementation, its tests, `src/index.ts`, and the matching README section. When changing a third-party adapter contract, inspect the installed package types/implementation rather than guessing its request or stream shape.

Keep changes focused and add or update tests in the same change. Prefer dependency injection already exposed by the library (`fetch`, `now`, and `TokenStore`) so tests remain deterministic and offline.

Run these checks after implementation:

```sh
npm run check
npm run build
```

`npm run check` runs formatting verification, lint, strict type checking, and all mocked tests. `npm run build` separately verifies distributable JavaScript, declarations, declaration maps, and source maps. During iteration, narrower commands are acceptable (`npm test`, `npm run typecheck`, `npm run lint`), but they do not replace both final commands.

Do not run `example:*` scripts as routine verification: they may start device login, read real credentials, contact external MCP servers, or spend account quota. Run one only when the task explicitly requires a live smoke test and the user has authorized it. Never use a real token in a test fixture or terminal output.

## Core behavior that must remain true

### Authentication and credentials

- Never log, return in error text, or place in model requests the access token, ID token, refresh token, authorization code, or device verifier.
- Treat token files as password-equivalent. Preserve atomic replacement and restrictive directory/file modes in `FileTokenStore`; clean up temporary files on failure.
- Keep this library's default token path separate from Codex CLI credentials so independent processes do not race to rotate one refresh token.
- Device polling must support cancellation, respect the authorization deadline and server interval, and distinguish pending responses from terminal failures.
- Refresh access tokens within the configured five-minute window. If expiry is unavailable, retain the fallback-age behavior.
- Preserve rotated refresh tokens and retain omitted fields from a refresh response where appropriate. Reject a confirmed account/workspace change.
- Deduplicate concurrent refreshes within an `OpenAIOAuth` instance.
- JWT parsing is decoding, not signature verification. It may derive expiry and OpenAI routing claims, but must not become a general authorization decision.

### Authenticated requests

- Always overwrite caller-supplied `authorization`, `originator`, `chatgpt-account-id`, and FedRAMP routing state from the active authenticated session. Remove stale optional routing headers when the active token does not supply them.
- On HTTP 401, cancel the first response body, force one refresh, and retry exactly once. Avoid unbounded retry loops and do not retry unrelated statuses implicitly.
- Preserve the caller's request input, init options, and non-managed headers.

### Provider adapters

- Language requests use the Responses API and must be streamed because the Codex backend rejects `stream: false`.
- AI SDK `doGenerate` must collect a streaming response without losing text, reasoning, tool calls/results, sources, files, provider metadata, response metadata, warnings, usage, or the finish reason. A stream error or missing finish data must fail clearly.
- Preserve the stateless tool-loop defaults: `store: false`, parallel tool calls enabled unless the supported caller option overrides them, and encrypted reasoning content carried between steps.
- TanStack streaming must preserve valid AG-UI lifecycle/tool/reasoning chunks from the official adapter. Promise-style structured output is collected from its streaming completion event.
- Non-language surfaces delegated to `@ai-sdk/openai` are backend/plan dependent. Do not claim support merely because a delegate method exists. Reranking remains explicitly unsupported unless the backend gains a verified implementation.
- Caller overrides may customize documented defaults, but must not bypass authentication or mandatory Codex constraints such as stateless streaming.

## Testing guidance

- Use `node:test` and `node:assert/strict`, matching the current suite.
- Mock network access with an injected fetch function. Assert URL, method, headers, serialized body, call count, and retry/rotation behavior where relevant.
- Use `MemoryTokenStore` and synthetic JWTs from `tests/helpers.ts`. Never read the default on-disk token store in tests.
- For device flow changes, cover success plus meaningful timeout, abort, pending, malformed response, and terminal error branches affected by the change.
- For refresh changes, cover near-expiry behavior, token rotation/field retention, workspace mismatch, concurrent refreshes, and valid-token fallback after a transient refresh failure as applicable.
- For stream conversion changes, construct realistic SSE/provider events and cover ordering, multiple content IDs, metadata, errors, and missing finish events as applicable.
- For adapters, test through the public SDK entry point (`generateText`, `streamText`, or `chat`) when possible, not only private helper behavior.
- Keep tests deterministic: inject time, avoid sleeps except tiny mocked polling intervals, and make no network or environment-dependent assertions.

## Public API and dependency changes

- Treat exported names, option shapes, error codes, defaults, token-store format, package exports, and documented behavior as compatibility-sensitive.
- When adding a public feature, update its implementation, `src/index.ts`, tests, and README example/limitations together. Ensure `npm run build` emits usable declarations.
- Keep `OpenAIOAuthError` codes specific and stable. Preserve the underlying cause and relevant HTTP status without leaking response secrets.
- Do not import undeclared transitive packages. Add direct runtime imports to `dependencies`, consumer-supplied SDK contracts to `peerDependencies` (and usually `devDependencies` for local tests), and build/test-only packages to `devDependencies`.
- Evaluate SDK upgrades against both adapter suites and their installed type definitions. Do not update a lockfile alone or assume a semver-compatible provider release preserves wire behavior.
- The published package currently exposes only the root entry point and `package.json`; add subpath exports only deliberately.
- Do not rename the package, token directory, environment variables, default originator, OAuth client ID, issuer, or backend URL as incidental cleanup. Such changes can break consumers or credential discovery and require an explicit migration decision.

## Documentation and examples

- Keep README snippets compilable against the public root exports and aligned with the supported peer versions.
- Clearly separate verified library behavior from capabilities controlled by a ChatGPT plan or the private backend.
- Preserve the warning that this integration follows an unstable non-public backend and must be used only with authorized accounts under applicable terms and workspace policies.
- Update `.env.example` for new non-secret configuration only. Never add actual credentials or an auth file to the repository.

## Change review checklist

- No secret material is logged, embedded, committed, or exposed through errors.
- Auth header precedence, account/FedRAMP routing, refresh deduplication, and one-retry behavior remain correct.
- Mandatory `stream: true`/`store: false` semantics and tool-loop reasoning continuity remain intact.
- New branches have deterministic mocked coverage at the appropriate public boundary.
- Public exports, README, examples, package metadata, and dependency declarations agree.
- `npm run check` and `npm run build` pass; any live example was run only with explicit authorization and is reported separately.
