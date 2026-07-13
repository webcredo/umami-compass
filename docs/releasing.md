# Releasing

Releases are prepared manually and published by one protected, idempotent GitHub Actions workflow. The workflow keeps npm, the official MCP Registry, and GitHub Releases on the same version.

## Prerequisites

- npm 12+, an npm account with 2FA, and trusted publishing configured for `webcredo/umami-compass`, `release.yml`, and the `npm` environment.
- The GitHub `npm` environment protected by required reviewers.
- A clean checkout of `main` with all required CI checks passing.

## Prepare

1. Update the version in `package.json`, `src/version.ts`, and both version fields in `server.json`. `tests/metadata.test.ts` prevents drift.
2. Move relevant `CHANGELOG.md` entries from Unreleased to the new version and date.
3. Run `pnpm install --frozen-lockfile`, `pnpm check`, official registry validation, and `npm pack --dry-run`.
4. Run `pnpm smoke:package`; it installs the packed tarball into an empty temporary project and performs CLI-version plus stdio initialize/list-tools smoke tests.
5. Open and merge a reviewed release pull request.

## Publish

1. Create and push a signed `vX.Y.Z` tag from the reviewed commit. If repository signing is not configured, use an annotated tag and rely on the protected release environment plus npm provenance; never use a lightweight release tag.
2. The tag automatically starts **Publish release**. The protected `npm` environment can still require a reviewer before publication.
3. The workflow verifies the exact tag and synchronized metadata, runs the full checks and packed-package smoke test, then validates `server.json` with the pinned official publisher.
4. It publishes the package with npm OIDC provenance, verifies both the immutable package version and its release channel, publishes MCP Registry metadata with GitHub OIDC, verifies Registry propagation, and creates the GitHub Release.
5. Verify the npm provenance link and release notes after the workflow completes. A manual workflow dispatch may be used to retry the same exact tag.

Do not use a long-lived npm token. Do not publish from an unreviewed local working tree. The workflow is safe to retry: it only accepts an existing npm version when its `gitHead` is the tagged commit, and it skips Registry or GitHub Release writes that already succeeded. A conflicting or incorrect immutable publication must be repaired with a new patch version.

CI installs the official `mcp-publisher` v1.7.9 binary with a pinned SHA-256 digest before validating `server.json`; update the version and checksum together from an official Registry release.

## Release channels and client updates

- A regular semantic version is published under npm `latest` and becomes the default auto-updating stable release.
- A semantic prerelease such as `0.3.0-rc.1` is published under npm `next` and creates a prerelease on GitHub.
- End-user stdio configs use `npx --yes --prefer-online umami-compass@latest`, so npm checks the stable channel whenever the MCP process starts.
- Reproducible CI and managed environments should use an exact package version without `--prefer-online`.

Local MCP processes never hot-swap their executable. Clients must restart the server after a release before they can discover newly added tools. Dynamic `notifications/tools/list_changed` is for a running server whose own tool list changes; it is not a package updater.

### First-package bootstrap

npm requires a package to exist before a trusted publisher can be configured. For the first release only, create a short-lived granular token with write access and bypass-2FA enabled, store it as `NPM_TOKEN` in the protected GitHub `npm` environment, and run the same release workflow. Immediately after `0.1.0` is live:

1. Configure the package's GitHub Actions trusted publisher for `webcredo/umami-compass`, workflow `release.yml`, environment `npm`, with publish permission.
2. Delete the `NPM_TOKEN` environment secret and revoke the token on npm.
3. Set package publishing access to require 2FA and disallow traditional tokens.

The workflow uses npm 12 and OIDC automatically once trust is configured. Future publishes need no npm secret.
