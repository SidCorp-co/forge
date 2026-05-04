import { getAuthToken, getBaseUrl } from "@/lib/api/client";
import type { PmEscalationRespond } from "./types";

/**
 * Desktop-side wrappers for the Epic 6 escalation respond endpoint.
 * Config / policies / decisions surfaces live on the web client; the desktop
 * intentionally only ships the inbox path.
 *
 * Uses a direct fetch instead of `request()` because the respond endpoint
 * returns 204 No Content — `request()` always parses JSON, so a 204 response
 * would crash the caller.
 */
export const pmApi = {
  respondToEscalation: async (
    projectId: string,
    decisionId: string,
    body: PmEscalationRespond,
  ): Promise<void> => {
    const base = getBaseUrl().replace(/\/$/, "");
    const token = getAuthToken();
    const res = await fetch(
      `${base}/api/projects/${projectId}/pm/escalations/${decisionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
  },
};
