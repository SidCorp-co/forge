import { apiClient } from "@/lib/api/client";
import type {
  InvokableSkill,
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

  invokable: (projectId: string) =>
    apiClient<{ skills: InvokableSkill[] }>(
      `/skills/invokable?projectId=${encodeURIComponent(projectId)}`,
    ),

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

  create: (projectId: string, body: SkillCreateInput) =>
    apiClient<SkillRow>(`/skills`, {
      method: "POST",
      body: JSON.stringify({ ...body, projectId }),
    }),

  update: (skillId: string, patch: SkillUpdateInput) =>
    apiClient<SkillRow>(`/skills/${encodeURIComponent(skillId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

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

  runSmokeVerify: (projectId: string, body: { tier: 1 | 2; stages?: string[] }) =>
    apiClient<SmokeVerifyRunResponse>(
      `/projects/${encodeURIComponent(projectId)}/skills/smoke-verify`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};
