# Release Process

1. Confirm `main` is protected and all required CI checks pass.
2. Update `CHANGELOG.md`, `package.json`, and `package-lock.json` to the same
   SemVer version.
3. Run `npm ci`, `npm run check`, and `npm run build` from a clean checkout.
4. Review `npm pack --dry-run --json` and confirm no credentials or unexpected
   files are present.
5. Merge the release pull request after review.
6. Create and push an immutable signed tag named `v<package-version>`.
7. Approve the `npm-production` GitHub Environment deployment.
8. Verify npm provenance, package contents, documented imports, and the GitHub
   release notes after publication.

Published versions cannot be replaced. For a bad release, deprecate the
affected version on npm, publish a corrected patch, and document the incident.

Repository administrators must require pull requests and CI on `main`, disable
force pushes and deletion, protect `v*` tags, enable private vulnerability
reporting and secret scanning, and require reviewers for the `npm-production`
environment. Configure npm Trusted Publishing for this repository and
`.github/workflows/publish.yml`; do not store a long-lived npm token.

Before the first release, rename the GitHub repository to
`openai-oauth-ai-provider` so its canonical URL matches the npm package
metadata and configure redirects from the former repository name.
