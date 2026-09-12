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

/** What a door may set for itself. Absent is the chat door's own two values, so a caller that names neither is bit-identical to every call made before ISS-985. */
export interface DuplicateDials {
  /** Score floor a match has to clear. */
  threshold?: number | undefined;
  /** How many of the project's recent draft/open issues are measured. */
  corpus?: number | undefined;
}

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
// cm:guard the two dials are the DOOR's, never the detector's: a door that wants a wider net or a longer corpus sets them here, and one that names neither gets the chat door's 0.72 over 50 rows unchanged — moving either default moves every door at once, which is the divergence per-door policy exists to stop
export async function findDuplicateIssue(
  db: Db,
  args: { projectId: string; title: string; description: string },
  dials: DuplicateDials = {},
): Promise<DuplicateMatch | null> {
  const threshold = dials.threshold ?? DUPLICATE_THRESHOLD;
  const corpus = dials.corpus ?? RECENT_ISSUES_LIMIT;
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
      .limit(corpus);
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
  return bestScore >= threshold ? best : null;
}
