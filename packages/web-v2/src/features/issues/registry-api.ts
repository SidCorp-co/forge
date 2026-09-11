// The pipeline registry read the status picker stands on (ISS-982).
//
// The per-rung exits table lives in core (`pipeline/state-machine.ts`) and
// reaches the UI ONLY here: core must not import `@forge/contracts` and
// contracts already depends on core, so no module can hold that table for both
// sides. A list of exits maintained in web is the defect this removed.

import {
  type PipelineRegistryResponse,
  pipelineRegistryResponseSchema,
} from "@forge/contracts/pipeline-registry";
import { apiClient } from "@/lib/api/client";

export const registryApi = {
  get: async (): Promise<PipelineRegistryResponse> =>
    pipelineRegistryResponseSchema.parse(await apiClient<unknown>("/pipeline/registry")),
};
