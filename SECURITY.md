# Security policy

## Supported versions

Until the first stable release, security fixes are made on the latest `0.x` release only.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Security → Report a vulnerability** private reporting flow for `webcredo/umami-compass`. Include the affected version, impact, reproduction steps, and any suggested mitigation.

You should receive an acknowledgement within 72 hours. We aim to provide an initial assessment within 7 days. Timelines for a fix and coordinated disclosure depend on severity and complexity.

## Security model

Umami Compass is a local stdio process. It connects only to the single Umami API root configured at process start.

- No tool accepts an upstream URL, fetches arbitrary HTML, or changes the API root.
- No mutation tool is shipped in `v0.2`.
- API keys, access tokens, usernames, and passwords are never returned or intentionally logged.
- Upstream response bodies are not copied into errors.
- Redirects are rejected to prevent credentials from being forwarded to another origin.
- Non-loopback HTTP is rejected unless explicitly allowed.
- Website and team allowlists, bounded pages/date ranges/decoded response bodies, request timeouts, and MCP cancellation limit access and resource use.
- Raw session replay event streams are excluded because they can be large and privacy-sensitive.

The MCP host is part of the trust boundary: it launches the process, supplies secrets, chooses which model receives results, and may log tool calls. Use a trusted host and a dedicated read-only Umami identity.

## Future remote and write capabilities

Public Streamable HTTP will not ship without OAuth 2.1 resource-server behavior, exact token audience validation, HTTPS, tenant isolation, rate limiting, and deployment guidance.

Future management modules must be separate from read modules and require explicit operator opt-in, least-privilege scopes, per-tool risk annotations, confirmation for destructive actions, audit events, and dedicated tests. The default policy will remain read-only.
