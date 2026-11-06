import type { HomeResponse } from "@forge/contracts/owner-home";
import { apiClient } from "@/lib/api/client";

/** The person's home across the projects they read (ISS-919): core's `GET /api/me/home`. */
export const homeApi = {
  get: (orgId: string | null) => apiClient<HomeResponse>(`/me/home${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
