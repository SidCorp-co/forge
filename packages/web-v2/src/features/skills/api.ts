// web-v2 feature module: skills — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Routes verified against
// `packages/core/src/skills/{crud-routes,routes}.ts` for ISS-299.
import { apiClient } from "@/lib/api/client";
import type {
  SkillFile,
  SkillRegistration,
  SkillRow,
  SkillSmokeVerifyReport,
  SkillSyncStatus,
  SkillTarget,
  SmokeVerifyRunResponse,
} from "./types";

/** Body for `POST /api/skills` (project skill — `isGlobal` omitted). */
export interface SkillCreateInput {
  name: string;
  description: string;
  skillMd: string;
  target?: SkillTarget;
  files?: SkillFile[];
}

/** Partial patch for `PUT /api/skills/:id`. */
export type SkillUpdateInput = Partial<SkillCreateInput>;

export const skillsApi = {
  /** `GET /api/skills?projectId&scope=all` — global + project skills. */
  list: (projectId: string) =>
    apiClient<SkillRow[]>(`/skills?projectId=${encodeURIComponent(projectId)}&scope=all`),

  /** `POST /api/skills/sync-status` — per-skill registered stages + hash. */
  syncStatus: (projectId: string) =>
    apiClient<SkillSyncStatus[]>(`/skills/sync-status`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  /** `GET /api/projects/:projectId/skill-registrations` — per-stage bindings. */
  registrations: (projectId: string) =>
    apiClient<{ registrations: SkillRegistration[] }>(
      `/projects/${encodeURIComponent(projectId)}/skill-registrations`,
    ),

  /** `POST /api/skills` — create a project skill (owner/admin). `projectId`
   *  required; `isGlobal` omitted so the row is always project-scoped. */
  create: (projectId: string, body: SkillCreateInput) =>
    apiClient<SkillRow>(`/skills`, {
      method: "POST",
      body: JSON.stringify({ ...body, projectId }),
    }),

  /** `PUT /api/skills/:id` — update a project skill (owner/admin). */
  update: (skillId: string, patch: SkillUpdateInput) =>
    apiClient<SkillRow>(`/skills/${encodeURIComponent(skillId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** `POST /api/projects/:projectId/skills/apply-default` — clone a global
   *  template into a new same-name project skill (owner/admin). Returns the new
   *  project SkillRow; only project skills may then be registered to a stage. */
  adopt: (projectId: string, globalSkillId: string) =>
    apiClient<SkillRow>(
      `/projects/${encodeURIComponent(projectId)}/skills/apply-default`,
      { method: "POST", body: JSON.stringify({ globalSkillId }) },
    ),

  /** `POST /api/projects/:projectId/skills/:skillId/register` — bind to stage. */
  register: (projectId: string, skillId: string, stage: string) =>
    apiClient<unknown>(
      `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/register`,
      { method: "POST", body: JSON.stringify({ stage }) },
    ),

  /** `DELETE /api/projects/:projectId/skills/registrations/:stage` — clear a stage. */
  unregister: (projectId: string, stage: string) =>
    apiClient<unknown>(
      `/projects/${encodeURIComponent(projectId)}/skills/registrations/${encodeURIComponent(stage)}`,
      { method: "DELETE" },
    ),

  /** `GET /api/projects/:projectId/skills/smoke-verify` — per-stage PASS/FAIL
   *  report (tier-1 always fresh + latest tier-2 canary outcomes). ISS-455. */
  smokeVerify: (projectId: string) =>
    apiClient<SkillSmokeVerifyReport>(
      `/projects/${encodeURIComponent(projectId)}/skills/smoke-verify`,
    ),

  /** `POST /api/projects/:projectId/skills/smoke-verify` — tier 1 re-runs the
   *  static checks; tier 2 (admin) additionally dispatches a `smoke` canary
   *  job per registered stage. */
  runSmokeVerify: (projectId: string, body: { tier: 1 | 2; stages?: string[] }) =>
    apiClient<SmokeVerifyRunResponse>(
      `/projects/${encodeURIComponent(projectId)}/skills/smoke-verify`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};
