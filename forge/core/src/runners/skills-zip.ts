import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

/**
 * Build a signed URL for the project's skill bundle (used by `host='remote'`
 * runners that can't read the device's filesystem).
 *
 * v1 implementation is a stub: returns null. A follow-up issue will:
 *   - serialise the skill manifest from `forge/core/src/skills/` registry
 *   - hash it (so unchanged manifests reuse the cached zip)
 *   - upload via `StorageAdapter` and return a URL the remote runner can GET
 *
 * Until then, `host='remote'` antigravity runners assume the remote service
 * has its own copy of skills. The dispatch is best-effort; if skills are
 * missing the remote will surface the error in its job output.
 */
export interface SkillsZipResult {
  url: string;
  hash: string;
  expiresAt: Date;
}

const cache = new Map<string, SkillsZipResult>();

export async function buildSkillsZipUrl(projectId: string): Promise<SkillsZipResult | null> {
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt.getTime() > Date.now()) return cached;

  // Stub: hash the project id so the URL is stable per-project. A real impl
  // would hash the actual manifest contents.
  const hash = createHash('sha256').update(`stub:${projectId}`).digest('hex').slice(0, 16);
  const corePublicUrl = process.env['CORE_PUBLIC_URL'];
  if (!corePublicUrl) {
    logger.warn(
      { projectId },
      'skills-zip: CORE_PUBLIC_URL not set, host="remote" antigravity dispatch will omit skills_zip',
    );
    return null;
  }
  const result: SkillsZipResult = {
    url: `${corePublicUrl.replace(/\/$/, '')}/api/runners/skills-zip/${hash}`,
    hash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  cache.set(projectId, result);
  return result;
}

export function clearSkillsZipCacheForTest(): void {
  cache.clear();
}
