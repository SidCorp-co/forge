// The `acceptanceCriteria` an issue read serves (ISS-1378).

import { db } from '../../db/client.js';
import { cleanCriteriaText, parseCriteriaText } from './criteria-text.js';
import { liveRows } from './store.js';

/**
 * `criteria-text.ts:cleanCriteriaText` over the issue's live rows in their order, so a text stored
 * with a prose line above criterion 1, which a locked issue can no longer rewrite, reads as the
 * criteria it holds. The rows are read only for such a text, and never written.
 */
export async function servedCriteriaText(
  issueId: string,
  stored: string | null,
): Promise<string | null> {
  if (stored === null || parseCriteriaText(stored).faults.length === 0) return stored;
  const rows = [...(await liveRows(db, issueId))].sort(
    (a, b) => a.position - b.position || a.n - b.n,
  );
  return cleanCriteriaText(stored, rows);
}
