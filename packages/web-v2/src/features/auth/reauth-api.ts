import { apiClient } from "@/lib/api/client";

/**
 * `POST /api/auth/reauth`: proves the password again, opening the few minutes in which core mints
 * a credential (a token on the tokens page, an MCP client's grant on its consent page).
 */
export function reauthWithPassword(password: string) {
  return apiClient<{ freshAuthAt: string }>(`/auth/reauth`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}
