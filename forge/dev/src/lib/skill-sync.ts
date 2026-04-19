import { getRemoteSkills, getRemoteSkill } from "./api";
import { invoke } from "@/hooks/use-tauri-ipc";
import type { AppConfig, SkillLibraryEntry, RemoteSkill } from "./types";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Auto-sync skills from Strapi for all configured projects.
 * Installs missing or outdated skills, then enables them per-project.
 */
export async function syncAllProjectSkills(config: AppConfig): Promise<boolean> {
  let changed = false;
  const library = config.skillLibrary ?? {};

  for (const [slug, pc] of Object.entries(config.projects)) {
    if (!pc.repoPath) continue;
    try {
      const synced = await syncSkillsForProject(slug, pc.repoPath, library);
      if (synced) changed = true;
    } catch (e) {
      console.error(`[skill-sync] Failed for project ${slug}:`, e);
    }
  }
  return changed;
}

async function syncSkillsForProject(
  slug: string,
  repoPath: string,
  library: Record<string, SkillLibraryEntry>,
): Promise<boolean> {
  const remoteSkills = await getRemoteSkills(slug);
  if (!remoteSkills.length) return false;

  // Find skills that need install or update
  const toSync = remoteSkills.filter((r) => {
    const local = library[r.name];
    if (!local) return true;
    return compareVersions(local.version, r.version) < 0;
  });

  if (!toSync.length) return false;

  console.log(`[skill-sync] ${slug}: installing ${toSync.length} skill(s)`);

  for (const skill of toSync) {
    try {
      await installAndEnable(skill, slug, repoPath);
      console.log(`[skill-sync] Installed: ${skill.name} v${skill.version}`);
    } catch (e) {
      console.error(`[skill-sync] Failed to install ${skill.name}:`, e);
    }
  }

  return true;
}

async function installAndEnable(skill: RemoteSkill, slug: string, repoPath: string) {
  const full = await getRemoteSkill(skill.documentId);
  await invoke("install_skill_from_strapi", {
    data: {
      name: full.name,
      description: full.description,
      version: full.version,
      skillMd: full.skillMd,
      files: full.files || [],
    },
  });
  await invoke("toggle_skill", { slug, repoPath, skillName: full.name, enabled: true });
}
