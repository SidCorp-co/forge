import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';

export interface DetectorKeyClaim {
  /** An existing non-closed issue already owns this key — comment on it. */
  existingIssueId: string | null;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** `doc-drift/architecture` — lowercase slash-separated slugs, ≤120 chars. */
export function isValidDetectorKey(key: string): boolean {
  return key.length <= 120 && KEY_RE.test(key);
}

export async function claimDetectorKey(
  projectId: string,
  detectorKey: string,
): Promise<DetectorKeyClaim> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.detectorKey, detectorKey),
        ne(issues.status, 'closed'),
      ),
    )
    .limit(1);
  return { existingIssueId: row?.id ?? null };
}
