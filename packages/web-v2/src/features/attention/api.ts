import { apiClient } from "@/lib/api/client";
import type { AttentionBucket, AttentionResponse } from "./types";

export const attentionApi = {
  /** `expand` names the buckets to list whole rather than capped (ISS-1229 r14). */
  list: (orgId?: string | null, expand: readonly AttentionBucket[] = []) => {
    const params = new URLSearchParams();
    if (orgId) params.set("orgId", orgId);
    for (const bucket of expand) params.append("expand", bucket);
    const query = params.toString();
    return apiClient<AttentionResponse>(query ? `/me/attention?${query}` : `/me/attention`);
  },
};
