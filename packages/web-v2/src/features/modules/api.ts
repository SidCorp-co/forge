import { apiClient } from "@/lib/api/client";
import type { CodeTraceResponse, ModuleDetail, ModuleRollupResponse } from "./types";

const base = (projectId: string) => `/projects/${projectId}/modules`;

export const modulesApi = {
  rollup: (projectId: string) => apiClient<ModuleRollupResponse>(`${base(projectId)}/rollup`),
  detail: (projectId: string, module: string) =>
    apiClient<ModuleDetail>(`${base(projectId)}/${encodeURIComponent(module)}/detail`),
  trace: (projectId: string) => apiClient<CodeTraceResponse>(`/projects/${projectId}/code-trace`),
};
