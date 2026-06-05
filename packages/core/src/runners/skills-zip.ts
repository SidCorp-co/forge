import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { resolveRegisteredEffectiveSkills } from '../skills/effective.js';
import { getStorage } from '../storage/index.js';
import { type ZipEntry, buildZip } from './zip.js';

/**
 * ISS-387 — build the project's skill bundle for `host='remote'` runners that
 * cannot read the dispatching device's filesystem.
 *
 * Real implementation (replaces the prior null stub):
 *   1. Resolve the project's REGISTERED effective skills (global + per-project
 *      overrides) via `resolveRegisteredEffectiveSkills` — the same set the
 *      device-sync manifest uses.
 *   2. Serialize them into a deterministic ZIP: `<skill-name>/SKILL.md` plus
 *      each attached file at `<skill-name>/<file.path>`.
 *   3. Content-hash the zip bytes (sha256) so an unchanged skill set reuses the
 *      cached archive; store the bytes via the `StorageAdapter`.
 *   4. Return a capability URL `<CORE_PUBLIC_URL>/api/runners/skills-zip/<hash>`
 *      the remote runner GETs (served by `runnerCallbackRoutes`, hash-gated).
 *
 * Best-effort: any failure (no skills, no CORE_PUBLIC_URL, storage error)
 * returns null and the dispatch proceeds without `skills_zip` — the remote then
 * surfaces missing-skill errors in its own job output, exactly as before.
 */
export interface SkillsZipResult {
  url: string;
  hash: string;
  expiresAt: Date;
}

const TTL_MS = 60 * 60 * 1000;
const STORAGE_PREFIX = 'skills-zip';

// Per-project memo of the last-built result (TTL-bounded).
const cache = new Map<string, SkillsZipResult>();
// hash → opaque StorageAdapter path, so the GET route can stream the bytes
// back without re-deriving a backend-specific key. Populated on build; a cold
// instance (post-restart) simply rebuilds on the next dispatch.
const pathByHash = new Map<string, string>();

function storageKey(hash: string): string {
  return `${STORAGE_PREFIX}/${hash}.zip`;
}

export async function buildSkillsZipUrl(projectId: string): Promise<SkillsZipResult | null> {
  const corePublicUrl = process.env.CORE_PUBLIC_URL;
  if (!corePublicUrl) {
    logger.warn(
      { projectId },
      'skills-zip: CORE_PUBLIC_URL not set, host="remote" antigravity dispatch will omit skills_zip',
    );
    return null;
  }

  const cached = cache.get(projectId);
  if (cached && cached.expiresAt.getTime() > Date.now() && pathByHash.has(cached.hash)) {
    return cached;
  }

  let entries: ZipEntry[];
  try {
    const skills = await resolveRegisteredEffectiveSkills(projectId);
    if (skills.length === 0) {
      logger.info(
        { projectId },
        'skills-zip: no registered skills for project, omitting skills_zip',
      );
      return null;
    }
    // Deterministic order: sort skills by name, files by path.
    entries = [];
    for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
      entries.push({
        path: `${skill.name}/SKILL.md`,
        data: Buffer.from(skill.skillMd, 'utf8'),
      });
      for (const file of [...skill.files].sort((a, b) => a.path.localeCompare(b.path))) {
        entries.push({
          path: `${skill.name}/${file.path}`,
          data: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'),
        });
      }
    }
  } catch (err) {
    logger.warn({ err, projectId }, 'skills-zip: failed to resolve effective skills, skipping');
    return null;
  }

  let result: SkillsZipResult;
  try {
    const zipBuf = buildZip(entries);
    const hash = createHash('sha256').update(zipBuf).digest('hex').slice(0, 32);
    const { path } = await getStorage().put(storageKey(hash), zipBuf, 'application/zip');
    pathByHash.set(hash, path);
    result = {
      url: `${corePublicUrl.replace(/\/$/, '')}/api/runners/skills-zip/${hash}`,
      hash,
      expiresAt: new Date(Date.now() + TTL_MS),
    };
  } catch (err) {
    logger.warn({ err, projectId }, 'skills-zip: failed to build/store bundle, skipping');
    return null;
  }

  cache.set(projectId, result);
  return result;
}

/**
 * Read a previously-built skills bundle by content hash, for the public GET
 * route the remote runner hits. Returns null when the hash is unknown to this
 * instance (cold after restart, or never built) so the caller can 404.
 */
export async function readSkillsZipByHash(hash: string): Promise<Buffer | null> {
  const path = pathByHash.get(hash);
  if (!path) return null;
  try {
    return await getStorage().get(path);
  } catch (err) {
    logger.warn({ err, hash }, 'skills-zip: stored bundle unreadable');
    return null;
  }
}

export function clearSkillsZipCacheForTest(): void {
  cache.clear();
  pathByHash.clear();
}
