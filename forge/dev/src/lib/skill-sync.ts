// LEGACY — Strapi-backed skill sync. The API helpers it relied on
// (`getRemoteSkills`, `getRemoteSkill`) were removed during the
// Strapi → forge/core migration. Until skill sync is re-implemented
// against the core endpoints (`/api/skills` + `/api/projects/:id/skills/sync`),
// this module no-ops so that callers (e.g. `use-web-socket.ts`) can
// keep importing it.
//
// TODO: rewrite against forge/core skill endpoints once schema settles.

import type { AppConfig } from "./types";

export async function syncAllProjectSkills(_config: AppConfig): Promise<boolean> {
  return false;
}
