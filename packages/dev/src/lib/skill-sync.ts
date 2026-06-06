import { invoke } from "@/hooks/use-tauri-ipc";
import { request, resolveProjectId } from "./api/client";
import type { AppConfig } from "./types";

/**
 * EPIC 6 (ISS-278/290/292) — pull effective skills from packages/core's
 * `/api/projects/:projectId/skills/effective` and write them through the
 * existing Tauri install commands. The endpoint lists global skills (read-only
 * built-in templates) + this project's project skills, NOT deduped (ISS-388):
 * the Studio UI needs both rows + the shadow relation. For installation we
 * dedup by NAME here so the device holds one folder per name — a same-name
 * project skill SHADOWS the global template (project wins).
 *
 * ISS-278 conflict resolution: Rust's `refresh_enabled_skills` returns a log
 * with `action="conflict"` entries when a project's local SKILL.md was edited
 * outside the app. We forward those as `skill-conflict` Tauri events so the
 * `<SkillConflictDialog>` mounted in the app shell can prompt the user.
 */

interface EffectiveSkill {
  id: string;
  name: string;
  description?: string | null;
  scope: "global" | "project";
  target?: "dev" | "cloud" | "all" | null;
  version?: number | string | null;
  skillMd?: string | null;
  localGuide?: string | null;
  contentHash?: string | null;
  files?: Array<{ path: string; content: string; encoding: string }>;
  // ISS-388 shadow relation (project skill shadowing a same-name global).
  shadowsGlobal?: boolean;
}

/**
 * Dedup the (non-deduped) Studio listing by name for installation: a
 * project-scoped skill shadows the same-name global template. One folder per
 * name lands on disk; the project body wins where both exist.
 */
function dedupByName(skills: EffectiveSkill[]): EffectiveSkill[] {
  const shadowedNames = new Set(
    skills.filter((s) => s.scope === "project").map((s) => s.name),
  );
  return skills.filter(
    (s) => s.scope === "project" || !shadowedNames.has(s.name),
  );
}

async function fetchEffectiveSkills(projectId: string): Promise<EffectiveSkill[]> {
  return dedupByName(await request<EffectiveSkill[]>(`/projects/${projectId}/skills/effective`));
}

async function getLocalHashes(): Promise<Record<string, string>> {
  try {
    return (await invoke<Record<string, string>>("get_skill_hashes")) ?? {};
  } catch {
    return {};
  }
}

async function installSkill(skill: EffectiveSkill): Promise<void> {
  const target = skill.target || "dev";
  const versionStr = skill.version != null ? String(skill.version) : "1.0.0";

  if (target === "cloud" || target === "all") {
    const guideContent =
      skill.localGuide ||
      `# ${skill.name}\n${skill.description || ""}\n\nTo load the current version, call: forge_skills get ${skill.name}`;
    await invoke("install_skill_guide", {
      data: {
        name: skill.name,
        description: skill.description || "",
        version: versionStr,
        localGuide: guideContent,
        contentHash: skill.contentHash || null,
      },
    });
  } else {
    await invoke("install_skill_from_strapi", {
      data: {
        name: skill.name,
        description: skill.description || "",
        version: versionStr,
        skillMd: skill.skillMd || "",
        files: skill.files || [],
        contentHash: skill.contentHash || null,
      },
    });
  }
}

/**
 * Sync skills for a single project — called both at app start (via
 * syncAllProjectSkills) and on the `skill.updated` WS event. Returns true if
 * any skill was installed/updated locally.
 */
export async function syncProjectSkills(slug: string, _repoPath: string): Promise<boolean> {
  let projectId: string;
  try {
    projectId = await resolveProjectId(slug);
  } catch (err) {
    console.warn(`[skill-sync] cannot resolve project id for slug=${slug}:`, err);
    return false;
  }

  let effective: EffectiveSkill[];
  try {
    effective = await fetchEffectiveSkills(projectId);
  } catch (err) {
    console.warn(`[skill-sync] /effective failed for project=${slug}:`, err);
    return false;
  }

  const localHashes = await getLocalHashes();
  let installed = 0;

  for (const skill of effective) {
    if (skill.contentHash && localHashes[skill.name] === skill.contentHash) {
      // Hash equality is necessary but not sufficient: pre-guard installs
      // left some SKILL.md files at 0 bytes whose cached hash still matches
      // the server. The disk check forces a re-fetch in that case. Catch
      // missing-command (older builds) by treating as OK so we don't loop.
      let bodyOK = true;
      try {
        // invoke types as `boolean | null`; ?? preserves the conservative
        // "treat null as OK" default so a missing command doesn't loop.
        bodyOK = (await invoke<boolean>("library_skill_body_ok", { name: skill.name })) ?? true;
      } catch {
        // Older desktop without the command — preserve original skip behavior.
      }
      if (bodyOK) continue;
      console.warn(`[skill-sync] hash matches but library SKILL.md is empty — re-installing ${skill.name}`);
    }
    // Skip skills with no body: packages/core registers some skills as
    // metadata-only (the legacy Strapi MCP uploads SKILL.md separately).
    // Writing an empty body wipes the existing local file and breaks the
    // /forge-* slash commands until a re-pair / re-sync. Better to leave
    // the local content alone and surface the gap as a server-side issue.
    const target = skill.target || "dev";
    const isCloud = target === "cloud" || target === "all";
    const hasBody = isCloud
      ? !!(skill.localGuide && skill.localGuide.trim())
      : !!(skill.skillMd && skill.skillMd.trim());
    if (!hasBody) {
      console.warn(`[skill-sync] skipping ${skill.name} — server returned empty body (target=${target})`);
      continue;
    }
    try {
      await installSkill(skill);
      installed++;
    } catch (err) {
      console.error(`[skill-sync] install failed (${skill.name}):`, err);
    }
  }

  if (installed > 0) {
    try {
      const log = await invoke<SkillSyncLog | null>("refresh_enabled_skills");
      await emitConflicts(log);
    } catch (err) {
      console.error("[skill-sync] refresh_enabled_skills failed:", err);
    }
  }

  return installed > 0;
}

interface SkillSyncLogEntry {
  skill: string;
  action: string;
  detail: string;
  projectSlug?: string | null;
  localContent?: string | null;
  serverContent?: string | null;
}

interface SkillSyncLog {
  timestamp: number;
  entries: SkillSyncLogEntry[];
}

export interface SkillConflictPayload {
  slug: string;
  skillName: string;
  localContent: string;
  serverContent: string;
  detail: string;
}

/**
 * Scan the refresh log for `action="conflict"` entries and forward each as a
 * `skill-conflict` Tauri event. The dialog component mounted in the app shell
 * subscribes via `@tauri-apps/api/event::listen`. Emit failures are logged
 * but never propagate — a missed event is preferable to crashing the sync.
 */
async function emitConflicts(log: SkillSyncLog | null | undefined): Promise<void> {
  if (!log?.entries?.length) return;
  const conflicts = log.entries.filter(
    (e): e is SkillSyncLogEntry & {
      projectSlug: string;
      localContent: string;
      serverContent: string;
    } =>
      e.action === "conflict" &&
      typeof e.projectSlug === "string" &&
      typeof e.localContent === "string" &&
      typeof e.serverContent === "string",
  );
  if (conflicts.length === 0) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    for (const c of conflicts) {
      const payload: SkillConflictPayload = {
        slug: c.projectSlug,
        skillName: c.skill,
        localContent: c.localContent,
        serverContent: c.serverContent,
        detail: c.detail,
      };
      await emit("skill-conflict", payload);
    }
  } catch (err) {
    console.error("[skill-sync] failed to emit skill-conflict events:", err);
  }
}

/** Sync skills for every project in the projects map — call on app start. */
export async function syncAllProjectSkills(
  projects: AppConfig["projects"] | undefined,
): Promise<boolean> {
  let any = false;
  for (const [slug, project] of Object.entries(projects ?? {})) {
    if (!project?.repoPath) continue;
    try {
      const synced = await syncProjectSkills(slug, project.repoPath);
      if (synced) any = true;
    } catch (err) {
      console.error(`[skill-sync] project=${slug} failed:`, err);
    }
  }
  return any;
}
