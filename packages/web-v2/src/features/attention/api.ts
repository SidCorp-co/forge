import { apiClient } from "@/lib/api/client";
import type { AttentionResponse } from "./types";

export const attentionApi = {
  list: (orgId: string | null) =>
    apiClient<AttentionResponse>(orgId ? `/me/attention?orgId=${encodeURIComponent(orgId)}` : `/me/attention`),
};
