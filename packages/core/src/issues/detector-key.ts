// One live issue per detector, enforced by the kernel rather than by prompt text.
//
// A detector (scheduled sweep, server-side propagation pass, audit skill) that
// re-finds the same class of problem every run must NOT open a new issue each
// time. Before this existed the rule lived only in each detector's prompt, was
// written wrong in two of them, and produced 7 near-identical CHANGELOG drafts
// and 21 doc-drift drafts on one project inside three weeks.

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

/**
 * Resolve whether `detectorKey` is already claimed by a live issue in this
 * project. Callers create only when this returns null; on a hit they append to
 * `existingIssueId` instead.
 *
 * Racing callers are not serialized here — the partial unique index
 * `issues_detector_key_live_uq` is what makes the invariant hard, and a loser
 * gets a constraint violation rather than a duplicate row.
 */
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
