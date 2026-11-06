// Whether the steward's one decision question about an item is already answered (REQ-48 BC-5): the
// same question open on it, a person's keep on the standing it reads now, or a reasoned decision
// recorded on that standing, which `asks.ts:answerOf` reads for the wake door too (ISS-1037: a dated
// or conditioned decision on a draft requirement keeps answering once the draft turns overdue).

import type { ItemStanding, StewardDecisionSubject } from '@forge/contracts/steward';
import { STEWARD_DECISION_OPTION_IDS } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { answerOf } from './asks.js';
import { fingerprintOf } from './decision-ask.js';

interface AskedRow {
  id: string;
  status: string;
  chosen: string | null;
  chosen_label: string | null;
  answered_at: string | null;
  fingerprint: string | null;
}

/**
 * Every question on the item, of every kind, newest first: the steward's own, a park's, a run's, and
 * the merge-or-drop question Forge asked on a draft before the steward took that job over. A
 * person's answer on any of them is read before the steward asks again (ISS-134 and ISS-284).
 */
async function questionsAskedOn(subject: {
  kind: StewardDecisionSubject;
  id: string;
}): Promise<AskedRow[]> {
  const on =
    subject.kind === 'issue'
      ? sql`q.issue_id = ${subject.id}`
      : subject.kind === 'requirement'
        ? sql`q.requirement_id = ${subject.id}`
        : sql`q.about ->> 'kind' = 'feedback' AND q.about ->> 'feedbackId' = ${subject.id}`;
  return rowsOf<AskedRow>(
    await db.execute(sql`
      SELECT q.id, q.status,
             q.steps -> -1 ->> 'chosenOptionId' AS chosen,
             (SELECT o ->> 'label' FROM jsonb_array_elements(q.steps -> -1 -> 'options') o
               WHERE o ->> 'id' = q.steps -> -1 ->> 'chosenOptionId' LIMIT 1) AS chosen_label,
             q.steps -> -1 ->> 'answeredAt' AS answered_at,
             q.steps -> -1 -> 'options' -> 0 ->> 'fingerprint' AS fingerprint
        FROM agent_questions q
       WHERE ${on}
         AND q.status IN ('open', 'answered')
       ORDER BY q.created_at DESC`),
  );
}

/** Whether an answer chose to keep the item as it is, whichever question asked it. */
export function choseKeep(chosen: string | null, label: string | null): boolean {
  if (!chosen) return false;
  return /(^|[._:-])keep([._:-]|$)/i.test(chosen) || /^\s*keep\b/i.test(label ?? '');
}

/**
 * The person's keep that still holds on the standing read now: the steward's own on this basis, or
 * a keep of any other question answered since the item came to read as it does.
 */
function keptNow(asked: readonly AskedRow[], basis: string, since: string | null) {
  return asked.find((q) => {
    if (q.status !== 'answered' || !choseKeep(q.chosen, q.chosen_label)) return false;
    const own = fingerprintOf(q.fingerprint ?? undefined);
    if (own && q.chosen === STEWARD_DECISION_OPTION_IDS.keep) return own.basis === basis;
    if (!since || !q.answered_at) return true;
    return new Date(q.answered_at).getTime() >= new Date(since).getTime();
  });
}

/**
 * What the turn is told where the question is already answered or asked on the item's standing now,
 * or null where it may be asked.
 */
export async function answeredAlready(
  projectId: string,
  about: string,
  subject: { kind: StewardDecisionSubject; id: string },
  standing: ItemStanding | null,
): Promise<string | null> {
  const asked = await questionsAskedOn(subject);
  const open = asked.find((q) => q.status === 'open');
  if (open) return `question ${open.id} on ${about} already asks it; ask nothing more.`;
  const kept = keptNow(asked, standing?.basis ?? 'none', standing?.since ?? null);
  if (kept) {
    return `${about} was kept on the standing it reads now (question ${kept.id}, answered ${kept.chosen_label ?? kept.chosen}): ask nothing until it moves.`;
  }
  const decided = standing ? await answerOf(projectId, standing, new Date()) : null;
  if (decided) {
    return `${about} has a decision recorded on this standing (${decided.at.toISOString()}: ${decided.decision ?? decided.why}): ask nothing while it holds; write the note.`;
  }
  return null;
}
