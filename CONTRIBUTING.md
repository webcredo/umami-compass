# Contributing to Umami Compass

Thanks for helping build a dependable Umami integration for the MCP ecosystem.

## Before opening a change

- Search existing issues and pull requests.
- For a new public tool, transport, auth strategy, or write capability, open a proposal first.
- Never include real analytics data, access tokens, cookies, user identifiers, or replay payloads in issues, fixtures, logs, commits, or screenshots.
- Keep the server independent from Umami internals: use public HTTP endpoints and contract-focused tests.

## Local setup

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use Node.js 22 or newer and pnpm 11.9.0. Copy `.env.example` to `.env` only for manual local testing; `.env` is gitignored and is not loaded automatically by the package.

## Project conventions

- TypeScript strict mode, ESM, Zod schemas, Biome formatting.
- One endpoint family per module in `src/mcp/modules`.
- MCP handlers stay thin; HTTP/auth behavior belongs in `src/api`.
- Every tool declares input/output schemas and honest MCP annotations.
- Every upstream request accepts the MCP cancellation signal.
- Tool errors must be useful but must not expose credentials, upstream bodies, or internal stack traces.
- User-controlled values may become query parameters or encoded path segments, never a host or arbitrary URL.
- New list endpoints need a hard maximum page size.
- New time-ranged endpoints use the shared UTC-aware range parser.
- Add tests for URL, headers, response preservation, error redaction, and the MCP-visible contract.

Read [Adding a tool](docs/adding-a-tool.md) and [Architecture](docs/architecture.md) before implementation.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Usage questions belong in [GitHub Discussions](https://github.com/webcredo/umami-compass/discussions); reproducible defects and accepted proposals belong in issues. See [SUPPORT.md](SUPPORT.md).

## Commit and pull request style

Use focused commits and [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat(events): add event property breakdown
fix(auth): refresh login token after 401
docs: explain Cloud API-key setup
```

Pull requests should explain the user value, upstream Umami version/endpoint, security and privacy implications, compatibility impact, and verification performed. Update `CHANGELOG.md` for user-visible changes.

By contributing, you agree that your contribution is licensed under the MIT License.

Maintainers should also follow the reviewed, provenance-backed [release process](docs/releasing.md).
