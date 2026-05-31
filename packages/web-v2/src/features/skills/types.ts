// web-v2 feature module: skills registry. Shapes verified against
// `packages/core/src/skills/{crud-routes,routes}.ts` for ISS-299:
//  - GET  /api/skills?projectId&scope          → SkillRow[]
//  - POST /api/skills/sync-status {projectId}   → SkillSyncStatus[]
//  - GET  /api/projects/:id/skill-registrations → { registrations: SkillRegistration[] }
//  - POST /api/projects/:id/skills/:sid/register {stage}
//  - DELETE /api/projects/:id/skills/registrations/:stage
export type SkillScope = "global" | "project";

/** A registerable pipeline stage = an `issueStatus` value (core enum). The
 *  register endpoint accepts the full status set; these are the pipeline
 *  states that actually drive a skill in this project's ladder. */
export const REGISTERABLE_STAGES = [
  "open",
  "confirmed",
  "approved",
  "developed",
  "testing",
  "released",
] as const;
export type RegisterableStage = (typeof REGISTERABLE_STAGES)[number];

/** Flat skill row from `GET /api/skills`. */
export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  scope: SkillScope;
  projectId: string | null;
  version: number | null;
  contentHash: string | null;
  target: string | null;
  source: string | null;
  tools: string[] | null;
  updatedAt: string;
  createdAt: string;
}

/** One row of `POST /api/skills/sync-status` — the per-skill registered stages
 *  (= where the skill is enabled) plus the stored hash/version. */
export interface SkillSyncStatus {
  skillId: string;
  skillName: string;
  target: string | null;
  scope: SkillScope;
  currentHash: string | null;
  currentVersion: number | null;
  updatedAt: string;
  registeredStages: string[];
}

/** One per-stage binding from `GET /skill-registrations`. */
export interface SkillRegistration {
  stage: string;
  skillId: string;
  skillName: string;
  skillScope: SkillScope;
  registeredBy: string | null;
  createdAt: string;
}

/** List row joined with its sync status — what the card renders. */
export interface SkillView extends SkillRow {
  registeredStages: string[];
  /** Stored in the registry (has a content hash) → considered synced. */
  synced: boolean;
}

/** Join the skill list with the sync-status rows (by skillId). */
export function mergeSkills(rows: SkillRow[], sync: SkillSyncStatus[]): SkillView[] {
  const byId = new Map(sync.map((s) => [s.skillId, s]));
  return rows.map((r) => {
    const s = byId.get(r.id);
    return {
      ...r,
      registeredStages: s?.registeredStages ?? [],
      synced: !!(s?.currentHash ?? r.contentHash),
    };
  });
}
