
import { apiClient } from "@/lib/api/client";
import type { PulseResponse } from "./types";

export const pulseApi = {
  get: (orgId?: string) =>
    apiClient<PulseResponse>(`/me/pulse${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
