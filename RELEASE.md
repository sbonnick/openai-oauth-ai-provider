# Release Process

Releases are created from `main`. Only repository administrators can create a
`v*` tag. Pushing a valid release tag automatically runs the npm publish
workflow with trusted publishing and provenance.

## Create a Release

1. Create a release branch from the current `main`.
2. Choose the next Semantic Versioning version and update both version files:

   ```sh
   npm version patch --no-git-tag-version
   ```

   Replace `patch` with `minor` or `major` when appropriate. This updates
   `package.json` and `package-lock.json` without creating a tag.
3. Review the release locally:

   ```sh
   npm ci
   npm run check
   npm run build
   npm pack --dry-run --json
   ```

4. Open a pull request with the version changes. Get the required approval and
   merge it after CI passes.
5. Update local `main` after the merge:

   ```sh
   git switch main
   git pull --ff-only
   ```

6. As a repository administrator, create and push the tag that exactly matches
   the package version:

   ```sh
   git tag -a v0.1.1 -m v0.1.1
   git push origin v0.1.1
   ```

7. Check the GitHub Actions **Publish** workflow. It verifies that the tag,
   `package.json`, and `package-lock.json` versions match; runs the checks;
   packs the artifact; and publishes it to npm. No manual npm command or
   environment approval is needed.
8. Confirm the published version and provenance on npm:

   ```sh
   npm view openai-oauth-ai-provider@0.1.1 version
   ```

## Correcting a Release

Published npm versions and release tags are immutable. Do not move or reuse a
tag. For a bad release, publish a corrected patch version. Deprecate the
affected npm version when appropriate.
