# ADR 0017 — Desktop OAuth via PKCE handoff

**Status:** Superseded by [ADR 0019](0019-desktop-device-pairing.md) (2026-05-24)
**Related:** [ADR 0014](0014-trunk-based-development.md), RFC 8252 (OAuth 2.0 for Native Apps), RFC 7636 (PKCE)

## Context

The Tauri desktop client (`packages/dev`) authenticates today with email + password against `POST /api/auth/local`. With ISS-314 the web app added GitHub / Google / OIDC sign-in, and we want the same providers in the desktop client.

The naive paths all fail in different ways:

| Approach | Why it fails |
|---|---|
| Embed a GitHub OAuth client in the desktop binary (Device Flow) | Requires shipping a `client_secret` inside an installable binary. Anyone with the binary can extract it and impersonate the desktop. Not viable — we'd need a per-installation server-side secret minted somewhere, which collapses back into something like the design below. |
| Token in the deep-link URL (`forge-beta://auth?token=<JWT>`) | Custom URL schemes can be claimed by any app on the system. A malicious app registering `forge-beta://` would silently capture the JWT during the OS handoff. Documented anti-pattern; same reason GitHub no longer allows token-bearing fragments in OAuth callbacks for native apps. |
| Loopback HTTP server (RFC 8252 §7.3) | Architecturally fine — `gh`, `gcloud`, GitHub Desktop all use it. Two reasons it's a worse fit *here*: (a) corporate firewalls / locked-down NATs sometimes block 127.0.0.1 binding; (b) we already need a web bridge page because the JWT cookie lives on the web origin after the OAuth callback — so we'd be paying for two redirect hops (browser → loopback → web → loopback) instead of one. |
| Token paste / device code | Adds a manual step on every login. The whole point of "Sign in with GitHub" is to avoid that. |

## Decision

Use **OAuth 2.0 PKCE (RFC 7636)** as a cross-process handoff between the desktop client and the existing web OAuth flow. The token is never put in a URL, never stored in a file, never embedded in a binary. The desktop proves it is the *same instance that started the flow* by presenting a `code_verifier` it kept in memory; the server checks `SHA256(verifier) == challenge` before issuing the JWT.

### Flow

```
Desktop (Tauri)             Web (Next.js)              Core API
───────────────             ─────────────              ────────
1. v = random_b64url(32)
   c = SHA256(v) [b64url]
   open browser:
   GET /api/auth/desktop/start ─────────────────────────→ insert oauth_handoff:
       ?provider=github                                     {id, provider,
       &code_challenge=<c>                                   code_challenge=c,
       &code_challenge_method=S256                           expires_at = now+5m}
                                                          302 → /api/auth/oauth/github/start
                                                                ?redirect=/auth/desktop/handoff?handoff=<id>
                                                          (existing OAuth flow runs;
                                                           cookie set on web origin)
                                                          302 → /auth/desktop/handoff?handoff=<id>

2.                          GET /auth/desktop/handoff
                            POST /api/auth/desktop/issue-code ──→ verify cookie owner;
                            {handoff_id}                           UPDATE row SET
                                                                    code_hash = SHA256(code),
                                                                    user_id = current_user
                                                                   WHERE id=$1 AND code_hash IS NULL
                                                                     AND consumed_at IS NULL
                                                                     AND expires_at > now()
                                                                ←─ {code}
                            Render "Open Forge Desktop" button:
                            href=forge-beta://auth/callback
                                 ?handoff_id=<id>&code=<code>

3. Tauri deep-link plugin captures URI
   POST /api/auth/desktop/exchange ─────────────────────→ atomic UPDATE … SET consumed_at=now()
   {handoff_id, code, code_verifier}                       WHERE id=$1 AND code_hash=SHA256(code)
                                                             AND consumed_at IS NULL
                                                             AND expires_at > now()
                                                           RETURNING user_id, code_challenge;
                                                          if SHA256(verifier) != code_challenge → 400 PKCE_MISMATCH
                                                          else sign JWT for user_id
                                                        ←─ {token, user}
4. setConfig({authToken: token}); navigate /
```

### Threat model

| Threat | Mitigation |
|---|---|
| Malicious app registers same `forge-beta://` scheme | Captured URI carries only `handoff_id` + `code` — useless without `code_verifier` (kept in desktop process memory only). |
| Network sniff | TLS, plus token is never in any URL — only in the body of the authenticated `/exchange` POST response. |
| Replay of `code` | `code_hash` consumed atomically by `UPDATE … RETURNING`; subsequent calls match no row → 400. |
| Session fixation (attacker starts flow, victim completes) | `code_verifier` proves the desktop calling `/exchange` is the same one that called `/start`. An attacker who started a flow can't substitute a victim's session because the attacker doesn't know the verifier. |
| Stolen `code_verifier` from disk | Verifier never written to disk — module-scoped JS variable, dies with the process. |
| `code_challenge_method=plain` downgrade | Server rejects anything other than `S256` (RFC 7636 §4.4.2 permits this when the server controls the client). |
| PKCE oracle (probe with bad verifier) | Atomic single-use means a wrong-verifier probe still **burns the code** before the verifier check runs. Attacker gets one shot per minted code. |
| Verifier comparison timing leak | `crypto.timingSafeEqual` on equal-length SHA256 hashes. |
| Handoff-table leak | Verifier is *not* stored — only the challenge (a hash). DB compromise → attacker still can't forge `/exchange`. |

### Why deep-link, not loopback

We picked deep-link over RFC 8252 §7.3 loopback because:
1. We need a web bridge page anyway — the auth cookie lives on the web origin after callback. With loopback we'd still need that page; with deep-link the same page does double duty.
2. No port binding, so no firewall / NAT issues for users behind enterprise networks.
3. `tauri-plugin-deep-link` is a first-party plugin in Tauri 2.x with installer-time scheme registration on macOS / Windows / Linux. Nothing per-OS to ship ourselves.

Loopback is also fine and we'd switch if a future Tauri version drops deep-link support — the API contract (`/start` → `/issue-code` → `/exchange`) is unchanged in either case; only the bridge between web and desktop differs.

### Why provider-aware from day one

`/desktop/start?provider=github|google|oidc` validates against the same registry the web's `<SocialLogin>` reads. Adding Google later is one OAuth-app config change, zero code. The desktop UI fetches `/api/auth/oauth/providers` and renders one button per enabled provider — no per-provider knowledge in the client.

### Why two flags

`socialAuth` (web) and `desktopOauth` (desktop) are independent on purpose. An operator may want web OAuth on while the desktop installer is still being rolled out, or vice versa. Both must be on for the desktop button to function.

## Consequences

### Positive

- Token never in a URL, never on disk, never in a binary.
- Single API contract works for all providers.
- Reuses the existing web OAuth flow unchanged — no duplicated callback logic.
- Standard enough to audit against published RFCs.

### Negative

- One extra DB table (`oauth_handoff`) with a periodic cleanup query.
- Tauri side needs the deep-link plugin and per-OS scheme registration (handled by the plugin's installer hooks).
- A bridge page (`/auth/desktop/handoff`) on the web that has only one job — small surface but adds a coupling between web and desktop releases.

### Conditions to re-evaluate

- **Tauri drops deep-link plugin support** — switch to loopback (RFC 8252 §7.3); API contract above is unchanged.
- **A provider grows a refresh-token surface we want to expose to the desktop** — extend `/exchange` response with `refresh_token` (HttpOnly cookie equivalent doesn't apply on native; would need encrypted-at-rest local storage). Out of scope for v1.
- **Mobile app un-pauses** ([ADR 0009](0009-mobile-app-paused-for-v0x.md)) — same flow works for iOS Universal Links / Android App Links with no API change.
