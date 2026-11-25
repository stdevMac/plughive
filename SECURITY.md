# Security policy

## Reporting a problem

Do not open a public issue for a security problem. Write to
SECURITY_CONTACT instead, with:

- what you found and where (file, route or tool),
- how to reproduce it,
- what an attacker could do with it.

You will get an answer within 7 days. Please give us 90 days, or until a fix
is released, before you publish details.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## What the daemon is meant to protect

plughive is a single-user daemon. Its design assumes:

- The machine and the account it runs under are trusted.
- MCP clients that hold the access key are trusted to call any tool their
  profile exposes. A profile limits what a client sees; it is not a sandbox.
- Web pages in your browser are not trusted. They must not be able to reach
  the daemon (DNS rebinding, cross-origin requests, CSRF).
- Content that tools fetch (web pages, remote MCP servers, model output) is
  not trusted.
- Packs you add yourself are trusted only as far as the permissions you
  granted when you enabled them.

In scope: anything that lets a web page, a remote server, tool output or a
pack go past those limits; any way a secret reaches a log, an error, a tool
result or an artifact; any way to reach the dashboard or `/api` without the
admin token.

Out of scope: an attacker who already runs code as your user; a pack doing
what you granted it; costs from calls you or your agent made; denial of
service from a client that holds the access key.

[docs/security.md](docs/security.md) describes the controls in detail.
