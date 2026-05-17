/**
 * In-memory plaintext PAT cache, scoped to the browser tab lifetime.
 *
 * The PAT plaintext is returned by `POST /api/pat` exactly once on creation.
 * The Tokens page (ISS-160) stashes it here so the MCP page (ISS-161) can
 * inline it into the per-client config snippets without forcing the user to
 * paste it manually. Refreshing or closing the tab clears the map by design:
 * we never persist plaintext to localStorage / sessionStorage because that
 * would defeat the one-time-reveal security model.
 *
 * Tokens not present in the map render with the `<YOUR_TOKEN_HERE>`
 * placeholder plus a rotate hint in the snippet output.
 */

const store = new Map<string, string>();

export function stashPlaintext(tokenId: string, plaintext: string): void {
  store.set(tokenId, plaintext);
}

export function getPlaintext(tokenId: string): string | null {
  return store.get(tokenId) ?? null;
}

export function clearPlaintext(tokenId: string): void {
  store.delete(tokenId);
}
