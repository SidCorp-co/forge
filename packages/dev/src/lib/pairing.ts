/**
 * Desktop sign-in via pairing code (ADR 0019; supersedes ADR 0017 PKCE).
 *
 * Flow:
 *   1. POST /api/auth/desktop/pair-init  → backend returns `pairing_code`
 *      ('XXX-XXXX') and `expires_at`.
 *   2. UI shows the code + a /connect-device URL the user opens in a signed-in
 *      browser and pastes the code into.
 *   3. We poll GET /api/auth/desktop/poll every 2 s (escalating to 5 s after
 *      30 s) until the backend returns 200 with `{token, user}`.
 *
 * No OS deep-link handler. No PKCE primitives. Works on Linux/Wayland,
 * headless SSH, macOS, Windows — anywhere the user can open a browser.
 */

import { invoke } from '@tauri-apps/api/core';
import { resolveApiBase } from './api-discovery';
import { Sentry } from './sentry';

export type PairingPhase =
  | 'initializing'
  | 'awaiting-approval'
  | 'consuming-code'
  | 'authenticated'
  | 'expired'
  | 'cancelled'
  | 'failed';

export interface PairingUser {
  id: string;
  email: string;
}

export interface PairingHandle {
  /** Formatted pairing code (`XXX-XXXX`) for display. */
  pairingCode: string;
  /** URL the user should open in a signed-in browser to approve the code. */
  connectUrl: string;
  /** When the code expires (after which polling stops and `done` rejects). */
  expiresAt: Date;
  /** Cancel the in-flight pairing, rejecting `done`. */
  cancel(): void;
  /** Resolves on successful exchange; rejects on cancel / expiry / 410. */
  done: Promise<{ token: string; user: PairingUser }>;
}

export interface StartPairingOptions {
  /** Forge core URL — e.g. https://forge-beta-api.example.com */
  coreUrl: string;
  /** Optional progress callback. Errors thrown by the callback are swallowed. */
  onPhase?: (phase: PairingPhase, extra?: Record<string, unknown>) => void;
}

interface PairInitResponse {
  pairing_code: string;
  expires_at: string;
}

interface PollSuccess {
  token: string;
  user: PairingUser;
}

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 5_000;
const SLOW_AFTER_MS = 30_000;

// Module-scoped so a new `startPairing` call can supersede the previous.
let activeHandle: { cancel: () => void } | null = null;

/**
 * Detect the platform string the backend wants ('linux'|'macos'|'windows').
 * navigator.userAgent reflects the host OS inside the Tauri webview.
 */
function detectPlatform(): 'linux' | 'macos' | 'windows' {
  const ua = (globalThis.navigator?.userAgent ?? '').toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

async function detectHostname(): Promise<string | undefined> {
  try {
    const h = await invoke<string>('get_hostname');
    return typeof h === 'string' && h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trim '/api' off the API base so the resulting URL points at the web origin
 * (single-origin deploys serve both from the same host).
 */
function webBaseFrom(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -'/api'.length) : trimmed;
}

function breadcrumb(
  phase: PairingPhase | 'poll-http-error' | 'poll-network-error',
  data?: Record<string, unknown>,
): void {
  Sentry.addBreadcrumb({
    category: 'pairing',
    level: phase === 'failed' || phase === 'expired' ? 'warning' : 'info',
    message: `pairing:${phase}`,
    data,
  });
}

export async function startPairing(opts: StartPairingOptions): Promise<PairingHandle> {
  if (activeHandle) {
    activeHandle.cancel();
    activeHandle = null;
  }

  const phase = (p: PairingPhase, extra?: Record<string, unknown>) => {
    breadcrumb(p, extra);
    try {
      opts.onPhase?.(p, extra);
    } catch {
      // Listener errors must not abort the flow.
    }
  };

  phase('initializing');

  const apiBase = await resolveApiBase(opts.coreUrl);
  const hostname = await detectHostname();
  const platform = detectPlatform();
  const label = hostname ? `${hostname} · Forge Beta` : 'Forge Beta';

  const initRes = await fetch(`${apiBase}/api/auth/desktop/pair-init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_label: label,
      device_platform: platform,
      device_hostname: hostname ?? null,
    }),
  });
  if (!initRes.ok) {
    const message = await safeErrorMessage(initRes);
    phase('failed', { stage: 'pair-init', status: initRes.status, message });
    throw new Error(`pair-init failed: ${message}`);
  }
  const init = (await initRes.json()) as PairInitResponse;

  const connectUrl = `${webBaseFrom(apiBase)}/connect-device?code=${encodeURIComponent(
    init.pairing_code,
  )}`;
  const expiresAt = new Date(init.expires_at);

  let cancelled = false;
  let resolveDone: (v: { token: string; user: PairingUser }) => void = () => {};
  let rejectDone: (err: Error) => void = () => {};
  const done = new Promise<{ token: string; user: PairingUser }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let nextTimer: ReturnType<typeof setTimeout> | null = null;
  let announcedAwaiting = false;
  const pollStart = Date.now();

  function clear() {
    if (nextTimer !== null) {
      clearTimeout(nextTimer);
      nextTimer = null;
    }
  }

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    clear();
    activeHandle = null;
    phase('cancelled');
    rejectDone(new Error('pairing cancelled'));
  }

  async function pollOnce(): Promise<void> {
    if (cancelled) return;
    if (Date.now() >= expiresAt.getTime()) {
      clear();
      activeHandle = null;
      phase('expired');
      rejectDone(new Error('pairing code expired'));
      return;
    }

    let res: Response;
    try {
      res = await fetch(
        `${apiBase}/api/auth/desktop/poll?pairing_code=${encodeURIComponent(init.pairing_code)}`,
      );
    } catch (err) {
      breadcrumb('poll-network-error', {
        message: err instanceof Error ? err.message : String(err),
      });
      schedule();
      return;
    }

    if (res.status === 204) {
      if (!announcedAwaiting) {
        announcedAwaiting = true;
        phase('awaiting-approval');
      }
      schedule();
      return;
    }

    if (res.status === 200) {
      phase('consuming-code');
      let payload: PollSuccess;
      try {
        payload = (await res.json()) as PollSuccess;
      } catch (err) {
        clear();
        activeHandle = null;
        phase('failed', { stage: 'poll-parse' });
        rejectDone(err instanceof Error ? err : new Error('failed to parse poll response'));
        return;
      }
      clear();
      activeHandle = null;
      phase('authenticated');
      resolveDone(payload);
      return;
    }

    if (res.status === 410) {
      const message = await safeErrorMessage(res);
      clear();
      activeHandle = null;
      phase('expired', { message });
      rejectDone(new Error(`pairing code unusable: ${message}`));
      return;
    }

    // Other status codes — transient HTTP error. Retry but breadcrumb.
    breadcrumb('poll-http-error', { status: res.status });
    schedule();
  }

  function schedule(): void {
    if (cancelled) return;
    const elapsed = Date.now() - pollStart;
    const delay = elapsed >= SLOW_AFTER_MS ? SLOW_POLL_MS : FAST_POLL_MS;
    nextTimer = setTimeout(() => {
      void pollOnce();
    }, delay);
  }

  activeHandle = { cancel };
  // Begin polling on the next tick so the caller sees the handle first.
  nextTimer = setTimeout(() => {
    void pollOnce();
  }, FAST_POLL_MS);

  return {
    pairingCode: init.pairing_code,
    connectUrl,
    expiresAt,
    cancel,
    done,
  };
}

async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { code?: string; message?: string };
    return j.message ?? j.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
