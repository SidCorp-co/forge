// web-v2 feature module: attention / inbox — REST surface. The endpoint is the
// EXISTING `GET /api/me/attention` (`packages/core/src/me/attention-routes.ts`);
// no core change was needed for ISS-307. Offline runners are merged in the hook
// from `features/runners` (`/me/devices`), not here.
import { apiClient } from "@/lib/api/client";
import type { AttentionResponse } from "./types";

export const attentionApi = {
  /** `GET /api/me/attention` — cross-project items needing the caller. */
  list: () => apiClient<AttentionResponse>(`/me/attention`),
};
