/**
 * Desktop OAuth client (ADR 0017).
 *
 * The desktop never embeds an OAuth client_secret and never receives a
 * Forge JWT in a URL. Flow:
 *
 *   1. start(provider, coreUrl)
 *      - generate PKCE code_verifier + code_challenge
 *      - keep verifier in module memory (never on disk)
 *      - open system browser to /api/auth/desktop/start
 *
 *   2. The user completes OAuth in the browser; the web bridge page
 *      issues a one-time `code` and redirects to forge-beta://auth/callback.
 *
 *   3. Tauri's deep-link plugin emits `deep-link://received`. We parse the
 *      URI, then exchange code+verifier for a JWT.
 *
 * See `docs/decisions/0017-desktop-oauth-pkce.md` for the threat model.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openUrl } from '@tauri-apps/plugin-shell';

export type DesktopProviderId = 'github' | 'google' | 'oidc';

export interface DesktopOAuthUser {
  id: string;
  email: string;
}

interface ExchangeResponse {
  token: string;
  user: DesktopOAuthUser;
}

/** Tauri event the Rust side emits when the OS hands us a forge-beta:// URL. */
const DEEP_LINK_EVENT = 'deep-link://received';
/** Custom URL scheme — must match tauri.conf.json plugins.deep-link.desktop.schemes. */
const SCHEME = 'forge-beta';
/** How long we wait for the deep-link to come back before giving up. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

// === PKCE primitives (Web Crypto, not Node crypto — frontend bundle) ===

function randomB64url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

async function sha256B64url(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return b64urlEncode(new Uint8Array(hash));
}

function b64urlEncode(buf: Uint8Array): string {
  // btoa wants a binary string; build it byte by byte to avoid TextDecoder issues.
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// === In-flight flow state ===
//
// Module-scoped — verifier never persists. Two concurrent flows would race
// on this single ref, so we explicitly disallow concurrent starts: the second
// caller cancels the first by overwriting (but cancel() throws to make this
// loud rather than silent).

interface PendingFlow {
  verifier: string;
  reject: (err: Error) => void;
}
let pending: PendingFlow | null = null;

// === Public API ===

export interface SignInOptions {
  /** Forge core API base URL — e.g. https://forge-beta-api.example.com */
  coreUrl: string;
  provider: DesktopProviderId;
}

/**
 * Run the full PKCE handoff. Returns the signed JWT + user when the
 * deep-link comes back and the exchange succeeds. Throws on:
 *   - timeout (no deep-link in 5 min)
 *   - exchange rejection (PKCE mismatch, expired handoff, etc.)
 *   - browser open failure
 */
export async function signInWithProvider(opts: SignInOptions): Promise<ExchangeResponse> {
  if (pending) {
    pending.reject(new Error('superseded by a new sign-in attempt'));
    pending = null;
  }

  const verifier = randomB64url(32);
  const challenge = await sha256B64url(verifier);
  const baseUrl = opts.coreUrl.replace(/\/+$/, '');
  const startUrl =
    `${baseUrl}/api/auth/desktop/start` +
    `?provider=${encodeURIComponent(opts.provider)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256`;

  // Subscribe BEFORE opening the browser — the user could complete OAuth
  // and bounce back faster than openUrl resolves on slow connections.
  return await new Promise<ExchangeResponse>((resolve, reject) => {
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    };

    pending = {
      verifier,
      reject: (err) => {
        cleanup();
        reject(err);
      },
    };

    listen<string>(DEEP_LINK_EVENT, async (event) => {
      const url = event.payload;
      if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://auth/callback`)) {
        return;
      }
      try {
        const parsed = new URL(url);
        const handoffId = parsed.searchParams.get('handoff_id');
        const code = parsed.searchParams.get('code');
        if (!handoffId || !code) {
          throw new Error('deep-link missing handoff_id or code');
        }
        const exchanged = await exchangeCode(baseUrl, {
          handoff_id: handoffId,
          code,
          code_verifier: verifier,
        });
        cleanup();
        resolve(exchanged);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })
      .then((u) => {
        unlisten = u;
      })
      .catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });

    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Sign-in timed out — no response from browser within 5 minutes.'));
    }, FLOW_TIMEOUT_MS);

    // Open the system browser. If this fails (no default browser, sandbox
    // denial), bail immediately — the deep-link would never arrive.
    openUrl(startUrl).catch((err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Cancel any in-flight flow (e.g. user navigated away from the login page). */
export function cancelInFlight(): void {
  if (pending) {
    pending.reject(new Error('cancelled'));
    pending = null;
  }
}

// === Internal: code exchange ===

async function exchangeCode(
  coreUrl: string,
  body: { handoff_id: string; code: string; code_verifier: string },
): Promise<ExchangeResponse> {
  const res = await fetch(`${coreUrl}/api/auth/desktop/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let bodyText: string;
    try {
      const j = (await res.json()) as { code?: string; message?: string };
      bodyText = j.message ?? j.code ?? `HTTP ${res.status}`;
    } catch {
      bodyText = `HTTP ${res.status}`;
    }
    throw new Error(`exchange failed: ${bodyText}`);
  }
  return (await res.json()) as ExchangeResponse;
}

// === Provider list ===

export interface OAuthProvider {
  id: DesktopProviderId;
  label: string;
}

interface ProvidersResponse {
  providers: OAuthProvider[];
}

/**
 * Ask the API which providers are configured + flagged enabled. Returns
 * `[]` (and never throws) so a misconfigured backend just hides the
 * social-sign-in section instead of breaking the login form.
 */
export async function fetchEnabledProviders(coreUrl: string): Promise<OAuthProvider[]> {
  try {
    const res = await fetch(`${coreUrl.replace(/\/+$/, '')}/api/auth/oauth/providers`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as ProvidersResponse;
    return Array.isArray(json.providers) ? json.providers : [];
  } catch {
    return [];
  }
}
