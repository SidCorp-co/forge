// Whether the steward may ask about an item again (REQ-48 BC-5, ISS-607). An ask is tied to the run
// that made it, so to the item and the standing basis that run read. On that same basis it is asked
// once: while it stands, after a reasoned decision answered it, and after the release holders were
// told. A decision recorded on the item after the ask, by anyone but the steward, answers it until the
// standing moves; a moved standing is a new basis, and asks again. The item is an issue, a feedback
// item or a requirement, and its decision is read where its own door writes one (ISS-654).

import type { StandingSubjectKind } from '@forge/contracts/steward';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { type ItemDecision, reasonedDecisionsOnItems } from '../comments/index.js';
import { db } from '../db/client.js';
import { stewardActs, stewardRuns } from '../db/schema-steward-runs.js';
import { type ReasonedDecision, reasonedDecisionsOn } from '../issues/index.js';
import { heldStewardOf } from './account.js';

/** The act door a wake of the master is logged under. */
export const WAKE_DOOR = 'WAKE master.wake steward';
/** The act door an ask of the release holders is logged under. */
export const NOTIFY_HOLDERS_DOOR = 'NOTIFY release holders';

export interface AskRow {
  id: string;
  door: string;
  at: Date;
  subjectKind: StandingSubjectKind;
  subjectId: string;
  subjectKey: string;
  basis: string | null;
  masterAsk: string | null;
  settledAt: Date | null;
}

const askColumns = {
  id: stewardActs.id,
  door: stewardActs.door,
  at: stewardActs.at,
  subjectKind: stewardRuns.subjectKind,
  subjectId: stewardRuns.subjectId,
  subjectKey: stewardRuns.subjectKey,
  basis: stewardRuns.basis,
  masterAsk: stewardActs.masterAsk,
  settledAt: stewardActs.askSettledAt,
};

/** A reasoned decision on the item an ask is about, whatever its kind. */
export type AskAnswer = ItemDecision;

/** A decision that still holds now: one whose `until` date, where it gives one, has not passed. */
const holds = (d: AskAnswer, now: Date) => d.until === null || d.until > now;

/**
 * The reasoned decisions on these items of one kind, newest first, the steward's own left out: an
 * issue's `decision` records (`issues/<id>/events`), or the decision comments on a feedback item or a
 * requirement (`projects/:id/<feedback|requirements>/:key/comments`, ISS-654).
 */
async function decisionsOn(
  kind: StandingSubjectKind,
  ids: readonly string[],
  except: readonly string[],
): Promise<AskAnswer[]> {
  if (kind !== 'issue') return reasonedDecisionsOnItems(kind, ids, except);
  return (await reasonedDecisionsOn(ids, except)).map((d: ReasonedDecision) => ({
    subjectId: d.issueId,
    at: d.at,
    decision: d.decision,
    why: d.why,
    until: d.until,
  }));
}

/** The reasoned decision recorded on each ask's item after that ask, newest first, by the item's own door. */
export async function answersOf(
  projectId: string,
  asks: readonly Pick<AskRow, 'id' | 'at' | 'subjectKind' | 'subjectId'>[],
  now: Date,
): Promise<Map<string, AskAnswer>> {
  const out = new Map<string, AskAnswer>();
  if (asks.length === 0) return out;
  const steward = await heldStewardOf(projectId);
  const except = steward ? [steward] : [];
  for (const kind of new Set(asks.map((a) => a.subjectKind))) {
    const ofKind = asks.filter((a) => a.subjectKind === kind);
    const decisions = await decisionsOn(kind, [...new Set(ofKind.map((a) => a.subjectId))], except);
    for (const ask of ofKind) {
      const answer = decisions.find(
        (d) => d.subjectId === ask.subjectId && d.at > ask.at && holds(d, now),
      );
      if (answer) out.set(ask.id, answer);
    }
  }
  return out;
}

/** The asks made about this item on this basis, newest first, but those a person undid. */
async function asksOnBasis(projectId: string, subjectId: string, basis: string) {
  return db
    .select(askColumns)
    .from(stewardActs)
    .innerJoin(stewardRuns, eq(stewardRuns.id, stewardActs.runId))
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        eq(stewardRuns.subjectId, subjectId),
        eq(stewardRuns.basis, basis),
        isNull(stewardActs.undoneAt),
        or(isNotNull(stewardActs.masterAsk), eq(stewardActs.door, NOTIFY_HOLDERS_DOOR)),
      ),
    )
    .orderBy(desc(stewardActs.at), desc(stewardActs.id));
}

/**
 * Why an ask about the item on this basis is not made again, said to the turn, or null where it may
 * be: an ask of the master that still stands or that a decision answered, or the release holders
 * already told. An ask settled because the standing moved off its basis and back asks again.
 */
export async function askedAlready(
  projectId: string,
  subject: { id: string; key: string },
  basis: string,
  now: Date,
): Promise<string | null> {
  const asks = await asksOnBasis(projectId, subject.id, basis);
  if (asks.length === 0) return null;
  const answers = await answersOf(projectId, asks, now);
  for (const ask of asks) {
    const answer = answers.get(ask.id);
    if (answer) {
      return `${subject.key} was asked on this standing (${ask.at.toISOString()}) and a decision answered it (${answer.at.toISOString()}: ${answer.decision ?? answer.why}). Ask nothing until its standing moves; write the note.`;
    }
    if (ask.door === NOTIFY_HOLDERS_DOOR) {
      return `the release holders were asked about ${subject.key} on this standing (${ask.at.toISOString()}). Ask nothing until its standing moves; write the note.`;
    }
    if (ask.settledAt === null) {
      return `the master's ask about ${subject.key} on this standing (${ask.at.toISOString()}) still stands. Ask nothing more; write the note.`;
    }
  }
  return null;
}

/** Each ask of the master still standing on the project, oldest first. */
export async function openMasterAsks(projectId: string): Promise<AskRow[]> {
  return db
    .select(askColumns)
    .from(stewardActs)
    .innerJoin(stewardRuns, eq(stewardRuns.id, stewardActs.runId))
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        isNotNull(stewardActs.masterAsk),
        isNull(stewardActs.askSettledAt),
        isNull(stewardActs.undoneAt),
      ),
    )
    .orderBy(stewardActs.at, stewardActs.id);
}

/** Settle these asks at `now`: they leave what the master is owed. */
export async function settleAsks(ids: readonly string[], now: Date): Promise<number> {
  if (ids.length === 0) return 0;
  const settled = await db
    .update(stewardActs)
    .set({ askSettledAt: now })
    .where(and(inArray(stewardActs.id, [...ids]), isNull(stewardActs.askSettledAt)))
    .returning({ id: stewardActs.id });
  return settled.length;
}
