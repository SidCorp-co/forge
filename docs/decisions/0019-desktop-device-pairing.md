# ADR 0019 — Desktop sign-in via pairing code

**Status:** Accepted (2026-05-24, supersedes [ADR 0017](0017-desktop-oauth-pkce.md))
**Related:** [ADR 0010](0010-clean-break-from-strapi.md), RFC 8628 (OAuth 2.0 Device Authorization Grant)

## Context

[ADR 0017](0017-desktop-oauth-pkce.md) introduced a PKCE handoff over a custom `forge-beta://` URL scheme. The desktop opens a system browser, the user completes OAuth on the web, the web bridge page issues a one-time code, and the browser bounces back into Tauri via a deep link carrying `(handoff_id, code)`. The desktop then exchanges code + verifier for a JWT.

This worked on macOS and Windows. On **Linux/Wayland (and some Linux/X11 configurations) the OS does not reliably bounce the `forge-beta://` URL into the running Tauri process** — ISS-190 (Ubuntu + Forge Beta v0.1.34) demonstrated the failure. After the browser renders the meta-refresh, the OS does nothing: the Tauri app stays in `awaiting-deep-link` for the entire 5-minute browser-wait budget. ISS-190 reduced the dead time to 30 s with diagnostics + a phased timeout, but the root cause — *we depend on the OS to deliver the URL* — was untouched.

Headless / SSH-forwarded sessions are an additional failure mode for the same reason: no URL handler.

## Decision

Replace the PKCE deep-link with a **device pairing code** (RFC 8628-inspired, like Apple TV / GitHub CLI / Steam). The desktop never receives a callback URL; it polls the API for a code the user approves in a signed-in browser session.

### Flow

```
Desktop (Tauri)            Browser (Next.js)                 Core API
───────────────            ─────────────────                  ────────
1. POST /api/auth/desktop/pair-init ────────────────────────→ insert desktop_pairing_codes:
   { device_label, device_platform,                            { code_hash = sha256(canonical),
     device_hostname }                                           device_label, platform,
                            ← { pairing_code: 'H7P-Q3K7',        hostname, created_ip,
                                expires_at }                     created_user_agent,
                                                                  expires_at = now()+10m }

2. UI shows 'H7P-Q3K7' + 'https://<core>/connect-device?code=H7P-Q3K7'
   User opens browser, signs in (cookie), types the code, clicks Approve.

3.                         POST /api/auth/desktop/approve ──→ atomic UPDATE:
                           Cookie: forge_auth=<jwt>            SET approved_user_id, approved_at
                           { pairing_code }                    WHERE code_hash=$h
                                                                AND approved_at IS NULL
                                                                AND consumed_at IS NULL
                                                                AND expires_at > now()
                                                              200 { approved, device }

4. GET /api/auth/desktop/poll?pairing_code=... ──────────────→ atomic UPDATE:
   (every 2 s, switching to 5 s after 30 s)                    SET consumed_at = now()
                                                                WHERE code_hash=$h
                                                                AND approved_user_id IS NOT NULL
                                                                AND consumed_at IS NULL
                                                                AND expires_at > now()
                                                              RETURNING approved_user_id
                            204 (still pending)
                            200 { token, user } (approved)
                            410 (expired / consumed / gone)
```

### Design choices

| Choice | Rationale |
|---|---|
| 7-char Crockford base32 code (`XXX-XXXX`) | Alphabet excludes `I O L U`. Code space 32^7 ≈ 3.4×10¹⁰; under 10-min TTL targeted guessing is infeasible. Length keeps the user's typing time low. |
| Store `sha256(canonical)` only | Match by hash so a database read never reveals a live code. Same defence the PKCE flow used for the post-redirect `code`. |
| TTL 10 min | Wider than the old 5-min handoff because the user has to type the code by hand. |
| HTTP polling, not WS/SSE | Login is a one-shot flow. Polling is one network call every 2 s for ≤ 10 min; no WS infra change required. |
| `pair-init` IP rate-limit 20/h | Prevents a flood of pending rows from one IP without locking out a NAT'd office. |
| `approve` IP rate-limit 10/h | Wrong submissions count too. Combined with the code space, brute force is infeasible. |
| Single 404 shape for `approve` misses | "Unknown" vs "already approved" vs "expired" all return `PAIRING_CODE_NOT_FOUND`. No oracle. |
| Distinct 410 reasons on `poll` | Desktop UI shows accurate text (consumed / expired / gone) without changing the security shape — the desktop already knows its own code. |

### Threat model

| Threat | Mitigation |
|---|---|
| Malicious app on the same OS claims `forge-beta://` | N/A — no custom URL scheme. |
| Network attacker sniffs the response | Same as ADR 0017: TLS terminates at the Forge API. The pairing code is a bearer-grade secret in transit but useless without typing it into a signed-in browser. |
| Shoulder-surf the printed pairing code | Code is single-use, 10-min TTL, requires a signed-in browser session to approve. Approving + consuming is one HTTP call each — no replay window of useful length. |
| Brute-force pairing code | 32^7 = 3.4×10¹⁰ space + 10-min TTL + 10/h/IP rate limit ⇒ expected attempts per code ≈ 5×10⁹. Infeasible. |
| User approves the wrong code | `/connect-device` renders device label / platform / hostname / IP / UA before the Approve button so the user can spot a fingerprint mismatch. |
| Token in URL or log | Token is only ever returned in the JSON body of a 200 poll response. Never logged, never appears in any URL. |

## Rejected alternatives

- **Keep PKCE deep-link in parallel** — duplicates test surface, UI confusion. Violates the clean-break principle from [ADR 0010](0010-clean-break-from-strapi.md). Project is at v0.1 with a small user base; alpha-stage break is acceptable.
- **Loopback HTTP server (RFC 8252 §7.3)** — same firewall / locked-down-NAT issues that ADR 0017 already discussed. Doesn't fix the Wayland delivery problem either, since the *browser* still has to reach localhost.
- **SSE / WebSocket for poll** — extra infrastructure (long-lived sockets, keep-alive proxy config) for no UX win on a one-shot login. The first successful poll on an approved code is the only one that matters.
- **QR code variant** — viable for v0.2+ if mobile-driven approval matters. Not in scope for the L-sized refactor; can layer onto the pairing-code surface later.

## Consequences

- `oauth_handoff` table is dropped (migration 0074). `/api/auth/desktop/{start,issue-code,exchange}` return 404.
- `tauri-plugin-deep-link` is removed from `Cargo.toml` and `tauri.conf.json`. The `forge-beta://` scheme registration is gone; installed installers from older releases still register the scheme on the OS but nothing handles it.
- `/auth/desktop/handoff` (Next.js) is deleted; `/connect-device` replaces it.
- `desktopPairing` feature flag (default-on) gates the three new endpoints. The old `desktopOauth` flag is gone in the same change.
- The pairing flow works on Linux/Wayland, headless SSH, macOS, Windows — anywhere the user can open a browser. ISS-190's reporter is the canonical acceptance test.
- Future enhancement: TOTP-style code rotation, QR code variant, or push-to-mobile approval can be layered onto the same `desktop_pairing_codes` schema without another migration.
