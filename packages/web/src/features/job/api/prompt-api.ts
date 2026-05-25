import { apiClient } from '@/lib/api/client';
import type { PromptEnvelope } from '../types-prompt';

export const promptApi = {
  get: (jobId: string) => apiClient<PromptEnvelope>(`/jobs/${jobId}/prompt`),
};
