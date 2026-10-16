// The consent page's picks, kept across the full-page round trip an SSO re-auth makes: stashed for
// this one request (its client and state) before the browser leaves, and read back once when it
// returns. Storage that refuses (a private window, blocked site data) only costs the picks.
import type { ConsentDraft, ConsentRequest } from "./consent-draft";

const KEY = "forge.mcp-consent-draft";

const requestKey = (request: ConsentRequest) => `${request.client_id ?? ""}|${request.state ?? ""}`;

export function stashDraft(request: ConsentRequest, draft: ConsentDraft): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ for: requestKey(request), draft }));
  } catch {}
}

/** The picks stashed for this request, once: reading them clears them. */
export function takeStashedDraft(request: ConsentRequest): ConsentDraft | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const held = JSON.parse(raw) as { for?: string; draft?: ConsentDraft };
    return held.for === requestKey(request) && held.draft ? held.draft : null;
  } catch {
    return null;
  }
}
