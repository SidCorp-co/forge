import type { McpConsentAnswer, McpConsentView } from "@forge/contracts/mcp-auth";
import { apiClient } from "@/lib/api/client";
import type { ConsentRequest } from "./consent-draft";

export const mcpAuthApi = {
  /** `GET /api/mcp-auth/authorize` — who asks and where the answer goes, or the refusal to show. */
  view: (request: ConsentRequest) =>
    apiClient<McpConsentView>(`/mcp-auth/authorize?${new URLSearchParams(request)}`),

  /** `POST /api/mcp-auth/authorize` — the decision; core answers where the browser goes next. May 403 FRESH_AUTH_REQUIRED. */
  decide: (decision: Record<string, unknown>) =>
    apiClient<McpConsentAnswer>(`/mcp-auth/authorize`, {
      method: "POST",
      body: JSON.stringify(decision),
    }),
};
