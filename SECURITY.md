# Security Policy

## Reporting a vulnerability

**Report privately — do not open a public issue for a suspected vulnerability.**

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/SidCorp-co/forge/security/advisories/new)**
(Security tab → *Report a vulnerability*). This opens a private advisory visible only to you and the
maintainers.

We aim to acknowledge a report within **72 hours** and to agree a disclosure timeline with you once
the impact is understood. Please give us a reasonable window to ship a fix before any public
disclosure.

Helpful details: affected package (`core` / `web-v2` / `runner` / `contracts`), version or commit,
a minimal reproduction, and the impact you observed.

## Supported versions

Forge is **alpha** — fixes land on `main` and ship in the next `v0.x` release. Only the latest
release and `main` are supported; there are no back-ports to older `v0.x` tags.

## Scope & design notes

- **The control-plane server never holds your Claude credentials** — a runner authenticates Claude
  on your own machine. A report showing the server can obtain or exfiltrate those credentials is
  in scope and high severity.
- In scope: auth/session handling, the MCP server (`/mcp`), the WebSocket server (`/ws`), the job
  pool and pipeline execution, secret handling in telemetry, and the runner's device pairing.
- Out of scope: findings that require a malicious runner box you already control, or social
  engineering of a maintainer.

## Automated hardening

CodeQL code scanning, secret scanning with push protection, and Dependabot security updates run on
this repository; alerts are triaged on the Security tab.
