# Releasing

Releases are intentionally manual until the project has stable maintainership and registry credentials.

## Prerequisites

- npm 12+, an npm account with 2FA, and trusted publishing configured for `webcredo/umami-compass`, `release.yml`, and the `npm` environment.
- The GitHub `npm` environment protected by required reviewers.
- `mcp-publisher` installed from the official MCP Registry release and authenticated with GitHub.
- A clean checkout of `main` with all required CI checks passing.

## Prepare

1. Update the version in `package.json`, `src/version.ts`, and both version fields in `server.json`. `tests/metadata.test.ts` prevents drift.
2. Move relevant `CHANGELOG.md` entries from Unreleased to the new version and date.
3. Run `pnpm install --frozen-lockfile`, `pnpm check`, official registry validation, and `npm pack --dry-run`.
4. Run `pnpm smoke:package`; it installs the packed tarball into an empty temporary project and performs CLI-version plus stdio initialize/list-tools smoke tests.
5. Open and merge a reviewed release pull request.

## Publish

1. Create and push a signed `vX.Y.Z` tag from the reviewed commit. If repository signing is not configured, use an annotated tag and rely on the protected release environment plus npm provenance; never use a lightweight release tag.
2. Run **Publish npm package** against that exact tag. The workflow refuses branch refs, uses npm OIDC trusted publishing, and emits provenance.
3. Verify the npm tarball, provenance, executable, README, and `mcpName` from a clean environment.
4. Run `mcp-publisher login github`, `mcp-publisher validate`, and `mcp-publisher publish` for `server.json`.
5. Create GitHub release notes from `CHANGELOG.md` and add the npm badge to README after the first successful publication.

Do not use a long-lived npm token. Do not publish from an unreviewed local working tree. A failed partial release should be repaired with a new patch version; published npm versions are immutable.

CI installs the official `mcp-publisher` v1.7.9 binary with a pinned SHA-256 digest before validating `server.json`; update the version and checksum together from an official Registry release.

### First-package bootstrap

npm requires a package to exist before a trusted publisher can be configured. For the first release only, create a short-lived granular token with write access and bypass-2FA enabled, store it as `NPM_TOKEN` in the protected GitHub `npm` environment, and run the same release workflow. Immediately after `0.1.0` is live:

1. Configure the package's GitHub Actions trusted publisher for `webcredo/umami-compass`, workflow `release.yml`, environment `npm`, with publish permission.
2. Delete the `NPM_TOKEN` environment secret and revoke the token on npm.
3. Set package publishing access to require 2FA and disallow traditional tokens.

The workflow uses npm 12 and OIDC automatically once trust is configured. Future publishes need no npm secret.
