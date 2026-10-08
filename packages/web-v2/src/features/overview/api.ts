
import { OPEN_WORK_STATES, missingWorkStateKey } from "@forge/contracts/work-state";
import { apiClient } from "@/lib/api/client";
import type { PulseResponse } from "./types";

export const pulseApi = {
  get: async (orgId?: string) => {
    const pulse = await apiClient<PulseResponse>(
      `/me/pulse${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`,
    );
    const missing = missingWorkStateKey(pulse.work?.buckets, OPEN_WORK_STATES);
    if (missing !== null) {
      throw new Error(
        `GET /me/pulse: \`work.buckets\` has no count for the work state \`${missing}\`, so the server predates the work states and no figure can be drawn from it. Reload once the server has been updated.`,
      );
    }
    return pulse;
  },
};
