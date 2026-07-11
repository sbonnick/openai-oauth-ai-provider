# Security Policy

## Supported versions

Security fixes are provided for the latest published version. Because this
package integrates with an unstable private backend, upgrading promptly is
strongly recommended.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository:

https://github.com/sbonnick/openai-oauth-ai-provider/security/advisories/new

Do not open a public issue for a suspected credential disclosure,
authentication bypass, unsafe request destination, or token-store flaw. Do not
include a live access token, ID token, refresh token, authorization code,
device verifier, user code, or token file. Use synthetic values and redact
request headers and bodies.

You should receive an acknowledgement within seven days. Please allow time for
investigation and a coordinated release before public disclosure. If a report
is confirmed, the maintainer will prepare a patched release and publish an
advisory describing affected versions and mitigations.

## Security boundaries

JWTs are decoded only for expiry and OpenAI routing metadata; signatures are
not verified by this package. Authentication is accepted only from the
configured OAuth exchange and password-equivalent token store. Model content
is sent to the configured ChatGPT Codex HTTPS origin. Remote MCP servers remain
independent third-party trust boundaries.
