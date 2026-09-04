/**
 * ISS-687 — dedup guard for chat-originated issue creation (direct create and PM-proposal create both flow through the one `forge_issues` create in `registry.ts`): deterministic title/description similarity over the project's recent draft/open issues, no embeddings, so it stays unit-testable; fails OPEN because a dedup error must never block a legitimate create.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { logger } from '../../logger.js';

const RECENT_ISSUES_LIMIT = 50;

/** Score floor for a duplicate; ISS-61..64 was the motivating near-identical-title case. */
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
    // cm:guard a title that clears the threshold ALONE is a duplicate, whatever the description scores — measured 2026-09-04: "Safari 17: login page blank after OAuth redirect" scored 0.727 against the draft filed one turn earlier and still went through as ISS-7, because two LLM-written descriptions of the same chat message share little vocabulary and the 25% description weight dragged the blend under 0.72; the blend still lets a weaker title be rescued by a near-identical description
    const score = Math.max(titleScore, titleScore * 0.75 + descScore * 0.25);
    if (score > bestScore) {
      bestScore = score;
      best = { id: row.id, issSeq: row.issSeq, title: row.title };
    }
  }
  return bestScore >= DUPLICATE_THRESHOLD ? best : null;
}
