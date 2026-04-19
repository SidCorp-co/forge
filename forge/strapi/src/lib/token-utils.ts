/**
 * Extract a user ID from a hub token.
 * Supports:
 * - JWT (header.payload.signature) — extracts sub/userId/id from payload
 * - Laravel Sanctum (userId|tokenHash) — extracts userId before the pipe
 */
export function extractUserIdFromToken(token?: string | null): string | undefined {
  if (!token) return undefined;

  // Sanctum format: "2842|tokenHash"
  if (token.includes('|') && !token.includes('.')) {
    const userId = token.split('|')[0];
    return userId || undefined;
  }

  // JWT format: "header.payload.signature"
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const id = payload.sub || payload.userId || payload.id;
      return id ? String(id) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
