// web-v2 feature module: workspace overview — REST surface.

import { apiClient } from "@/lib/api/client";
import type { PulseResponse } from "./types";

export const pulseApi = {
  /** `GET /api/me/pulse` — the whole dashboard in one org-scoped read. */
  get: (orgId?: string) =>
    apiClient<PulseResponse>(`/me/pulse${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
