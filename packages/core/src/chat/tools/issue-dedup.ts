/**
 * ISS-687 — lightweight dedup guard for chat-originated issue creation. Fires
 * on BOTH the direct-create path (Bao answering directly) and the
 * PM-advisory-proposal-create path (Bao creating on the PM's behalf) since
 * both flow through the one `forge_issues` create action wired in
 * `registry.ts`. Deterministic title/description similarity over the
 * project's recent draft/open issues — not semantic embeddings — so the
 * guard stays dependency-light, unit-testable, and reproducible. Fails OPEN:
 * a dedup query error must never block a legitimate create.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { logger } from '../../logger.js';

/** Recent draft/open issues considered for a duplicate match — bounded so the
 *  check stays cheap even on a busy project. */
const RECENT_ISSUES_LIMIT = 50;

/** Combined-score floor above which two issues are treated as duplicates.
 *  Tunable post-deploy against real repeat-report patterns (ISS-61..64 was
 *  the motivating near-identical-title case); start conservative. */
const DUPLICATE_THRESHOLD = 0.72;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/** Jaccard similarity over word sets: 0 (disjoint vocabulary) to 1 (identical). */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection += 1;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateMatch {
  id: string;
  issSeq: number;
  title: string;
}

/**
 * Best near-duplicate among the project's recent `draft`/`open` issues, or
 * null when nothing clears {@link DUPLICATE_THRESHOLD}. Title similarity is
 * weighted heavier than description — it's the surface a repeat report is
 * most likely to echo verbatim. Fails OPEN on a DB error (returns null).
 */
export async function findDuplicateIssue(
  db: Db,
  args: { projectId: string; title: string; description: string },
): Promise<DuplicateMatch | null> {
  let rows: Array<{ id: string; issSeq: number; title: string; description: string | null }>;
  try {
    rows = await db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.projectId, args.projectId), inArray(issues.status, ['draft', 'open'])))
      .orderBy(desc(issues.createdAt))
      .limit(RECENT_ISSUES_LIMIT);
  } catch (err) {
    logger.warn({ err, projectId: args.projectId }, 'chat.issue-dedup: query failed; failing open');
    return null;
  }

  let best: DuplicateMatch | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const titleScore = titleSimilarity(args.title, row.title);
    const descScore = titleSimilarity(args.description, row.description ?? '');
    const score = titleScore * 0.75 + descScore * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = { id: row.id, issSeq: row.issSeq, title: row.title };
    }
  }
  return bestScore >= DUPLICATE_THRESHOLD ? best : null;
}
