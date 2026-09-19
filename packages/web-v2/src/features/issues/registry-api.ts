
import {
  type PipelineRegistryResponse,
  pipelineRegistryResponseSchema,
} from "@forge/contracts/pipeline-registry";
import { apiClient } from "@/lib/api/client";

export const registryApi = {
  get: async (): Promise<PipelineRegistryResponse> =>
    pipelineRegistryResponseSchema.parse(await apiClient<unknown>("/pipeline/registry")),
};
