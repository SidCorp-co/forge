// web-v2 feature module: integrations hub — REST surface. Route verified
// against `packages/core/src/integrations/routes.ts` (ISS-305).
import { apiClient } from "@/lib/api/client";
import type { IntegrationsStatus } from "./types";

export const integrationsApi = {
  /** `GET /api/projects/:projectId/integrations/status` — composed real status. */
  status: (projectId: string) =>
    apiClient<IntegrationsStatus>(`/projects/${projectId}/integrations/status`),
};
