import type { HomeFindResponse, HomeResponse } from "@forge/contracts/owner-home";
import { apiClient } from "@/lib/api/client";
import type { PulseResponse } from "./types";

const orgQuery = (orgId: string | null | undefined) => (orgId ? `orgId=${encodeURIComponent(orgId)}` : "");

export const pulseApi = {
  get: (orgId?: string) =>
    apiClient<PulseResponse>(`/me/pulse${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};

/** The person's home across the projects they read (ISS-919): core's `GET /api/me/home` and its search. */
export const homeApi = {
  get: (orgId: string | null) => {
    const q = orgQuery(orgId);
    return apiClient<HomeResponse>(`/me/home${q ? `?${q}` : ""}`);
  },
  find: (text: string, orgId: string | null) => {
    const q = orgQuery(orgId);
    return apiClient<HomeFindResponse>(`/me/home/find?q=${encodeURIComponent(text)}${q ? `&${q}` : ""}`);
  },
};
