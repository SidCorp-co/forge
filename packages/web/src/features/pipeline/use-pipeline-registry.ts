import { useQuery } from '@tanstack/react-query';
import {
  pipelineRegistryResponseSchema,
  type PipelineRegistryResponse,
} from '@forge/contracts';
import { apiClient } from '@/lib/api/client';

/**
 * Fetches the pipeline registry served from core (`GET /api/pipeline/registry`).
 * The registry is the single source of truth for `PIPELINE_STEPS`,
 * `RUNNER_CAPABILITIES`, and `MANUAL_ONLY_JOB_TYPES`. UI components consume
 * this hook instead of hardcoding any of those maps so future drift is
 * impossible — the server changes, all clients pick it up.
 *
 * The registry rarely changes (per-project skill bindings live in a separate
 * endpoint), so we cache aggressively. WS event `pipeline.registry_changed`
 * invalidates the query on the rare config-update path.
 */
export function usePipelineRegistry() {
  return useQuery<PipelineRegistryResponse>({
    queryKey: ['pipeline', 'registry'],
    queryFn: async () => {
      const data = await apiClient<unknown>('/pipeline/registry');
      return pipelineRegistryResponseSchema.parse(data);
    },
    staleTime: 5 * 60_000,
    gcTime: 60 * 60_000,
  });
}
