/**
 * Pure diff helper for `POST /api/projects/:projectId/skills/sync`. Split out
 * so the categorisation logic can be unit-tested without a database.
 *
 * Uses `contentHash` as the change signal: matching hash → unchanged; different
 * hash → update. `mode` controls whether existing rows missing from the
 * incoming payload are flagged for removal.
 */

export interface SyncManifestInput {
  name: string;
  description?: string | undefined;
  prompt: string;
  tools: string[];
  version?: string | undefined;
  hash: string;
}

export interface ExistingSkill {
  name: string;
  contentHash: string;
}

export type SyncMode = 'partial' | 'full';

export interface SkillDiff {
  toInsert: SyncManifestInput[];
  toUpdate: SyncManifestInput[];
  unchanged: string[];
  toRemove: string[];
}

export function computeSkillDiff(
  existing: ExistingSkill[],
  incoming: SyncManifestInput[],
  mode: SyncMode = 'partial',
): SkillDiff {
  const existingByName = new Map(existing.map((s) => [s.name, s]));
  const incomingNames = new Set<string>();

  const diff: SkillDiff = { toInsert: [], toUpdate: [], unchanged: [], toRemove: [] };

  for (const manifest of incoming) {
    incomingNames.add(manifest.name);
    const current = existingByName.get(manifest.name);
    if (!current) {
      diff.toInsert.push(manifest);
    } else if (current.contentHash !== manifest.hash) {
      diff.toUpdate.push(manifest);
    } else {
      diff.unchanged.push(manifest.name);
    }
  }

  if (mode === 'full') {
    for (const s of existing) {
      if (!incomingNames.has(s.name)) {
        diff.toRemove.push(s.name);
      }
    }
  }

  return diff;
}
