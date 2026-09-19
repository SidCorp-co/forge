import { apiClient } from "@/lib/api/client";
import type { AttentionResponse } from "./types";

export const attentionApi = {
  list: () => apiClient<AttentionResponse>(`/me/attention`),
};
