import type { CapabilitiesView } from "@forge/contracts/capabilities";
import type { DoorUseView, PilesView } from "@forge/contracts/door-use";
import type { ModulePillarResponse, ModuleTreeResponse } from "@forge/contracts/module-map";
import { apiClient } from "@/lib/api/client";
import type { ModuleDetail } from "./types";

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/modules`;

export const modulesApi = {
  /** `GET /projects/:id/modules/map` — the pillar: every business module's counts, and the Unplaced row. */
  pillar: (projectId: string) => apiClient<ModulePillarResponse>(`${base(projectId)}/map`),
  /** `GET /projects/:id/modules/:module/map` — one module's tree, each node with its relations. */
  tree: (projectId: string, module: string) => apiClient<ModuleTreeResponse>(`${base(projectId)}/${encodeURIComponent(module)}/map`),
  /** The module an issue names, read by its hover card. */
  detail: (projectId: string, module: string) => apiClient<ModuleDetail>(`${base(projectId)}/${encodeURIComponent(module)}/detail`),
};

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

/** The Capabilities branch's reads (ISS-1251 §7), each over the last `days`. */
export const capabilitiesApi = {
  /** `GET /api/projects/:id/metrics/doors` — every door's calls by agent kind, its card, and what agents read. */
  doors: (projectId: string, days: number) => apiClient<DoorUseView>(`${projectPath(projectId)}/metrics/doors?days=${days}`),
  /** `GET /api/projects/:id/metrics/piles` — each text every prompt carries, against its cap. */
  piles: (projectId: string) => apiClient<PilesView>(`${projectPath(projectId)}/metrics/piles`),
  /** `GET /api/projects/:id/metrics/capabilities` — the reports agents filed on a door, and the lessons on its card. */
  extra: (projectId: string, days: number) => apiClient<CapabilitiesView>(`${projectPath(projectId)}/metrics/capabilities?days=${days}`),
};
