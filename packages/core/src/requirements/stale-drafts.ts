/**
 * A draft untouched for a week gets one merge-or-drop question from the assistant (REQ-41 BC-12;
 * Requirement lifecycle `draft`, Issue lifecycle `draft`). The sweep finds draft requirements, draft
 * revisions and draft issues whose newest touch is DRAFT_STALE_DAYS old, with no open question and
 * none of this kind written within the spell, and asks one choice question on the record: merge
 * into a named item, drop, or keep, with a recommended answer and its reason read from the product
 * record only (requirements, feedback, and what shipped: an accepted requirement), never the code.
 * Answering is a person's; the master carries the chosen act out (`executedBy: agent`), and a keep
 * buys another spell. Before the question a draft is `awaiting_proposal`, which is not a decision.
 */

import { randomUUID } from 'node:crypto';
import { requirementKey } from '@forge/contracts/requirements';
import {
  DRAFT_STALE_DAYS,
  STALE_DRAFT_OPTION_IDS,
  type StaleDraftAnswer,
} from '@forge/contracts/stale-drafts';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList, rowsOf } from '../db/raw-sql.js';
import { issueDisplayIds, staleDraftIssues } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { askQuestion } from '../questions/index.js';
import { feedbackLinksOf } from './feedback-links.js';
import { nearDuplicatesOf } from './near-duplicate.js';

const DAY_MS = 86_400_000;

/** The jsonb a merge-or-drop question's first round options contain, for a `@>` test. */
const ASKED_MARK = JSON.stringify([{ id: STALE_DRAFT_OPTION_IDS.drop }]);

/** What the product record says about one stale draft, read before recommending. */
export interface DraftFacts {
  key: string;
  /** A live item it reads as the same as: a near-duplicate requirement, a same-titled issue. */
  mergeInto: string | null;
  /** Open feedback that asks for it. */
  asks: readonly string[];
  /** The requirement it delivers has ended: accepted (shipped) or dropped. */
  ended: { key: string; status: 'accepted' | 'dropped' } | null;
  days: number;
}

export interface Recommendation {
  answer: StaleDraftAnswer;
  why: string;
}

/**
 * The recommended answer, first rule that holds: what it delivers has ended → drop; it reads as a
 * live item → merge into it; open feedback asks for it → keep; else nothing asks for it → drop.
 */
export function recommendationOf(f: DraftFacts): Recommendation {
  if (f.ended) {
    return {
      answer: 'drop',
      why: `${f.ended.key}, the requirement it delivers, is ${f.ended.status}, so no work waits on this draft.`,
    };
  }
  if (f.mergeInto) {
    return {
      answer: 'merge',
      why: `it reads as the same as ${f.mergeInto}, which is live; one record keeps one history.`,
    };
  }
  if (f.asks.length > 0) {
    return {
      answer: 'keep',
      why: `open feedback still asks for it: ${f.asks.join(', ')}.`,
    };
  }
  return {
    answer: 'drop',
    why: `nobody touched it for ${f.days} days, and no open feedback or live item asks for it.`,
  };
}

const LABELS: Record<StaleDraftAnswer, (into: string | null) => string> = {
  merge: (into) => (into ? `Merge into ${into}` : 'Merge into another item'),
  drop: () => 'Drop it',
  keep: () => 'Keep it as a draft',
};

/** The question's prompt and its three options, the recommended one named with its reason. */
export function staleDraftQuestion(
  subject: { key: string; title: string; what: string },
  facts: DraftFacts,
) {
  const rec = recommendationOf(facts);
  const fingerprint = `stale-draft:${subject.key}`;
  const options = (Object.keys(STALE_DRAFT_OPTION_IDS) as StaleDraftAnswer[]).map((a) => ({
    id: STALE_DRAFT_OPTION_IDS[a],
    label: LABELS[a](facts.mergeInto),
    authority: 'writer' as const,
    bindsTo: 'this_call' as const,
    executedBy: 'agent' as const,
    fingerprint,
  }));
  const label = LABELS[rec.answer](facts.mergeInto);
  const prompt = `${subject.key} "${subject.title}" is ${subject.what} nobody has touched for ${facts.days} days. Merge it into another item, drop it, or keep it? Recommended: ${label}, because ${rec.why}`;
  return { prompt, options, recommendedOptionId: STALE_DRAFT_OPTION_IDS[rec.answer] };
}

interface StaleRequirementRow {
  id: string;
  project_id: string;
  req_seq: number;
  title: string;
  status: string;
  current_revision: number | null;
  draft_revision: number | null;
  touched_at: Date | string;
}

async function staleRequirementDrafts(cutoff: Date): Promise<StaleRequirementRow[]> {
  return rowsOf<StaleRequirementRow>(
    await db.execute(sql`
      SELECT r.id, r.project_id, r.req_seq, r.title, r.status, r.current_revision,
             max(v.revision) FILTER (WHERE v.state = 'draft') AS draft_revision,
             GREATEST(r.updated_at, max(v.created_at), max(v.proposed_at), max(v.decided_at)) AS touched_at
        FROM requirements r
        LEFT JOIN requirement_revisions v ON v.requirement_id = r.id
       WHERE r.status NOT IN ('dropped', 'deferred')
       GROUP BY r.id
      HAVING (r.status = 'draft' OR bool_or(v.state = 'draft'))
         AND NOT coalesce(bool_or(v.state = 'proposed'), false)
         AND GREATEST(r.updated_at, max(v.created_at), max(v.proposed_at), max(v.decided_at)) <= ${cutoff.toISOString()}
         AND NOT EXISTS (
               SELECT 1 FROM agent_questions q
                WHERE q.requirement_id = r.id
                  AND (q.status = 'open'
                       OR (q.steps -> 0 -> 'options' @> ${ASKED_MARK}::jsonb
                           AND q.updated_at > ${cutoff.toISOString()})))
       ORDER BY r.project_id, r.req_seq`),
  );
}

const CLOSED_FEEDBACK = ['verified', 'declined'];

async function requirementFacts(row: StaleRequirementRow, now: Date): Promise<DraftFacts> {
  const [{ near }, links] = await Promise.all([
    nearDuplicatesOf({
      id: row.id,
      projectId: row.project_id,
      reqSeq: Number(row.req_seq),
      currentRevision: row.current_revision === null ? null : Number(row.current_revision),
    }),
    feedbackLinksOf(row.project_id, [row.id]),
  ]);
  const twin = near.filter((n) => !n.decided).sort((a, b) => b.similarity - a.similarity)[0];
  return {
    key: requirementKey(Number(row.req_seq)),
    mergeInto: twin?.key ?? null,
    asks: links.filter((l) => !CLOSED_FEEDBACK.includes(l.status)).map((l) => `FB-${l.fbSeq}`),
    ended: null,
    days: Math.floor((now.getTime() - new Date(row.touched_at).getTime()) / DAY_MS),
  };
}

/** Per draft issue, the open feedback routed to it and the requirement it delivers where that ended. */
async function issueContext(ids: readonly string[]) {
  if (ids.length === 0) return { asks: new Map<string, string[]>(), ended: new Map() };
  const asks = rowsOf<{ issue_id: string; fb_seq: number }>(
    await db.execute(sql`
      SELECT x.issue_id, f.fb_seq FROM (
        SELECT c.issue_id, c.feedback_id FROM feedback_route_issues c WHERE c.issue_id IN (${idList(ids)})
        UNION SELECT f2.issue_id, f2.id FROM feedback f2 WHERE f2.issue_id IN (${idList(ids)})
      ) x JOIN feedback f ON f.id = x.feedback_id
       WHERE f.status NOT IN ('verified', 'declined')
       ORDER BY f.fb_seq`),
  );
  const ended = rowsOf<{ issue_id: string; req_seq: number; status: 'accepted' | 'dropped' }>(
    await db.execute(sql`
      SELECT i.id AS issue_id, r.req_seq, r.status FROM issues i
        JOIN requirements r ON r.id = i.requirement_id
       WHERE i.id IN (${idList(ids)}) AND r.status IN ('accepted', 'dropped')`),
  );
  const asksBy = new Map<string, string[]>();
  for (const a of asks)
    asksBy.set(a.issue_id, [...(asksBy.get(a.issue_id) ?? []), `FB-${a.fb_seq}`]);
  return {
    asks: asksBy,
    ended: new Map(
      ended.map((e) => [
        e.issue_id,
        { key: requirementKey(Number(e.req_seq)), status: e.status } as const,
      ]),
    ),
  };
}

async function ask(input: {
  projectId: string;
  on: { requirementId: string } | { issueId: string };
  subject: { key: string; title: string; what: string };
  facts: DraftFacts;
}): Promise<boolean> {
  const q = staleDraftQuestion(input.subject, input.facts);
  try {
    await askQuestion({
      id: randomUUID(),
      projectId: input.projectId,
      ...input.on,
      prompt: q.prompt,
      blockerKind: 'human',
      answer: { shape: 'choice', options: q.options, recommendedOptionId: q.recommendedOptionId },
    });
    return true;
  } catch (err) {
    logger.error(
      { err, projectId: input.projectId, key: input.subject.key },
      'stale-draft-sweep: the merge-or-drop question was refused; the draft stays unasked',
    );
    return false;
  }
}

/** One pass: every stale draft asked once. */
export async function sweepStaleDrafts(
  now: Date = new Date(),
): Promise<{ asked: number; refused: number }> {
  const cutoff = new Date(now.getTime() - DRAFT_STALE_DAYS * DAY_MS);
  let asked = 0;
  let refused = 0;
  const tally = (ok: boolean) => {
    if (ok) asked += 1;
    else refused += 1;
  };
  for (const row of await staleRequirementDrafts(cutoff)) {
    const facts = await requirementFacts(row, now);
    const draft = row.draft_revision === null ? null : Number(row.draft_revision);
    tally(
      await ask({
        projectId: row.project_id,
        on: { requirementId: row.id },
        subject: {
          key: facts.key,
          title: row.title,
          what:
            row.status === 'draft' ? 'a draft requirement' : `a draft revision (r${draft ?? '?'})`,
        },
        facts,
      }),
    );
  }
  const issues = await staleDraftIssues(cutoff, ASKED_MARK);
  const ids = issues.map((i) => i.id);
  const [context, keys] = await Promise.all([
    issueContext(ids),
    issueDisplayIds([...ids, ...issues.flatMap((i) => (i.twinId ? [i.twinId] : []))]),
  ]);
  for (const issue of issues) {
    const key = keys.get(issue.id) ?? `ISS-${issue.issSeq}`;
    tally(
      await ask({
        projectId: issue.projectId,
        on: { issueId: issue.id },
        subject: { key, title: issue.title, what: 'a draft issue' },
        facts: {
          key,
          mergeInto: issue.twinId ? (keys.get(issue.twinId) ?? null) : null,
          asks: context.asks.get(issue.id) ?? [],
          ended: context.ended.get(issue.id) ?? null,
          days: Math.floor((now.getTime() - issue.touchedAt.getTime()) / DAY_MS),
        },
      }),
    );
  }
  return { asked, refused };
}

/** Which of these requirements an open merge-or-drop question stands on, for their standing. */
export async function openMergeOrDropOf(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = rowsOf<{ requirement_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT q.requirement_id FROM agent_questions q
       WHERE q.requirement_id IN (${idList(ids)}) AND q.status = 'open'
         AND q.steps -> 0 -> 'options' @> ${ASKED_MARK}::jsonb`),
  );
  return new Set(rows.map((r) => r.requirement_id));
}
