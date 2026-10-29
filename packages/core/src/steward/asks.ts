// Whether the steward may ask about an item again (REQ-48 BC-5, ISS-607). An ask is keyed on the
// standing of the item it is about, never on the run that made it: FB-83's run asking about ISS-498
// is an ask about ISS-498 (K53 on dev.293: four FB-run asks on ISS-498 stood after a decision there).
// While that standing is unchanged it is asked once: a reasoned decision recorded on the item during
// it answers it, whether recorded before the first ask or after (FB-198); an ask of the master that
// still stands, or the holders of the act it waits on told (ISS-654), holds it. A moved standing (a
// new wait, the wait gone stuck, a run reading the item on another basis) asks again.
// The item is an issue, a feedback item or a requirement, its decision read where its own door
// writes one (ISS-654). An ask about another item than its run's own (a stuck issue asking about its
// blocker) is answered on either, and a decision recorded since the ask leaves the master's nudge at
// once, not at the next sweep (ISS-739). A wait a person owes is never the master's, so its ask settles.

import type { ItemStanding, StandingSubjectKind, StewardCite } from '@forge/contracts/steward';
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import { type ItemDecision, reasonedDecisionsOnItems } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { stewardActs, stewardRuns } from '../db/schema-steward-runs.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { type ReasonedDecision, reasonedDecisionsOn } from '../issues/index.js';
import { heldStewardOf } from './account.js';
import { waitsOnPerson } from './ask-addressee.js';
import { decisionSubjectOf } from './decision-subject-of.js';

/** The act door a wake of the master is logged under. */
export const WAKE_DOOR = 'WAKE master.wake steward';

/**
 * Hold the ask lock on one item of a project until the transaction ends: whoever asks about the item
 * next waits, then reads the ask this one wrote, so two runs at once ask once.
 */
export async function lockAsksOn(tx: Tx, projectId: string, about: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`steward-ask:${projectId}:${about}`}, 0))`,
  );
}
/** Every act door an ask of an act's holders is logged under (`ask-addressee.ts:HeldAct.door`). */
const NOTIFY_HOLDERS = 'NOTIFY %';
const toldHolders = (door: string) => door.startsWith('NOTIFY ');

export interface AskRow {
  id: string;
  door: string;
  at: Date;
  /** The run that made it: its item, and the basis it read of that item. */
  subjectKind: StandingSubjectKind;
  subjectId: string;
  subjectKey: string;
  basis: string | null;
  masterAsk: string | null;
  settledAt: Date | null;
  wrote: StewardCite | null;
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
  wrote: stewardActs.wrote,
};

/**
 * The key of the item an ask is about: the item it cites (`door-wake.ts` writes it), else the key its
 * master ask opens with (`<KEY>: <ask>`, as the wake door has always written it), else its run's item.
 */
export function aboutKeyOf(ask: Pick<AskRow, 'wrote' | 'masterAsk' | 'subjectKey'>): string {
  if (ask.wrote?.ref) return ask.wrote.ref.toUpperCase();
  const prefix = ask.masterAsk ? /^([A-Z]+-\d+): /i.exec(ask.masterAsk)?.[1] : undefined;
  return (prefix ?? ask.subjectKey).toUpperCase();
}

/** The kind of item an ask is about, by its key: REQ-n, FB-n, or an issue. */
export function aboutKindOf(key: string): StandingSubjectKind {
  return key.startsWith('REQ-') ? 'requirement' : key.startsWith('FB-') ? 'feedback' : 'issue';
}

/** An item a decision on answers an ask. */
export interface AnsweredOn {
  kind: StandingSubjectKind;
  key: string;
}

/**
 * The items a decision on answers an ask (ISS-739): the item it is about, then the item of the run
 * that asked where that is another, so the stuck item answers an ask about its blocker too.
 */
export function answeredOnOf(
  ask: Pick<AskRow, 'wrote' | 'masterAsk' | 'subjectKey' | 'subjectKind'>,
): AnsweredOn[] {
  const about = aboutKeyOf(ask);
  const own = ask.subjectKey.toUpperCase();
  const items: AnsweredOn[] = [{ kind: aboutKindOf(about), key: about }];
  if (own !== about) items.push({ kind: ask.subjectKind, key: own });
  return items;
}

/** The standing an ask is weighed against: the item's, read now. */
export type AskedStanding = Pick<ItemStanding, 'subject' | 'basis' | 'since' | 'stuck'>;

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

const runAt = sql<Date | null>`coalesce(${stewardRuns.startedAt}, ${stewardRuns.queuedAt})`;

/**
 * When the item's standing began to read as it does now: when its wait began, or went stuck, where a
 * run read it on another basis no later than that; else the first run that read it as now after the
 * last that read it otherwise (the change fell between them, and nothing earlier counts). Null where
 * no run has read it as now since: nothing recorded yet is on it.
 */
async function standingBeganAt(standing: AskedStanding): Promise<Date | null> {
  const floor = new Date(
    Math.max(Date.parse(standing.since), Date.parse(standing.stuck?.since ?? standing.since)),
  );
  const ofItem = and(eq(stewardRuns.subjectId, standing.subject.id), isNotNull(stewardRuns.basis));
  const [other] = await db
    .select({ at: sql<string | null>`max(${runAt})` })
    .from(stewardRuns)
    .where(and(ofItem, ne(stewardRuns.basis, standing.basis)));
  if (!other?.at || new Date(other.at) < floor) return floor;
  const [first] = await db
    .select({ at: sql<string | null>`min(${runAt})` })
    .from(stewardRuns)
    .where(
      and(
        ofItem,
        eq(stewardRuns.basis, standing.basis),
        sql`${runAt} > ${sqlTimestamp(new Date(other.at))}`,
      ),
    );
  return first?.at ? new Date(first.at) : null;
}

/** Whether a moment falls on the standing as it reads now (`standingBeganAt`). */
const onStanding = (at: Date, began: Date | null) => began !== null && at >= began;

/**
 * The newest reasoned decision recorded on the item while its standing reads as now, by the item's
 * own door and anyone but the steward, that still holds: it answers an ask on that standing, made
 * before it or after (ISS-607 c2).
 */
export async function answerOf(
  projectId: string,
  standing: AskedStanding,
  now: Date,
  began?: Date | null,
): Promise<AskAnswer | null> {
  const steward = await heldStewardOf(projectId);
  const decisions = await decisionsOn(
    standing.subject.kind,
    [standing.subject.id],
    steward ? [steward] : [],
  );
  const from = began === undefined ? await standingBeganAt(standing) : began;
  return decisions.find((d) => holds(d, now) && onStanding(d.at, from)) ?? null;
}

/**
 * The asks about this item made on its standing as it reads now, newest first, but those a person
 * undid: an ask whose run read the item itself on another basis is off it.
 */
async function asksOnStanding(projectId: string, standing: AskedStanding, began: Date | null) {
  if (began === null) return [];
  const key = standing.subject.key.toUpperCase();
  const rows = await db
    .select(askColumns)
    .from(stewardActs)
    .innerJoin(stewardRuns, eq(stewardRuns.id, stewardActs.runId))
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        isNull(stewardActs.undoneAt),
        gte(stewardActs.at, began),
        or(isNotNull(stewardActs.masterAsk), like(stewardActs.door, NOTIFY_HOLDERS)),
        or(
          sql`upper(${stewardActs.wrote} ->> 'ref') = ${key}`,
          sql`upper(${stewardActs.masterAsk}) LIKE ${`${key}: %`}`,
          and(isNull(stewardActs.wrote), eq(stewardRuns.subjectId, standing.subject.id)),
        ),
      ),
    )
    .orderBy(desc(stewardActs.at), desc(stewardActs.id));
  return rows.filter(
    (ask) =>
      aboutKeyOf(ask) === key &&
      (ask.subjectId !== standing.subject.id || ask.basis === standing.basis),
  );
}

/**
 * Why an ask about the item on its standing now is not made again, said to the turn, or null where
 * it may be: a decision recorded on that standing answered it, or one on the standing of `asker`, the
 * run's own item where it asks about another (ISS-739); an ask of the master on it still stands, or
 * the act's holders were told on it. Whichever run asks, the item asked about decides.
 */
export async function askedAlready(
  projectId: string,
  standing: AskedStanding,
  now: Date,
  asker: AskedStanding | null = null,
): Promise<string | null> {
  const key = standing.subject.key;
  const began = await standingBeganAt(standing);
  const answer = await answerOf(projectId, standing, now, began);
  if (answer) {
    return `${key} has a decision recorded on this standing, so a decision answered it (${answer.at.toISOString()}: ${answer.decision ?? answer.why}). Ask nothing until its standing moves; write the note.`;
  }
  const own = asker && asker.subject.id !== standing.subject.id ? asker : null;
  const ownAnswer = own ? await answerOf(projectId, own, now) : null;
  if (own && ownAnswer) {
    return `${own.subject.key}, whose run asks about ${key}, has a decision recorded on its standing, so a decision answered it (${ownAnswer.at.toISOString()}: ${ownAnswer.decision ?? ownAnswer.why}). Ask nothing until its standing moves; write the note.`;
  }
  for (const ask of await asksOnStanding(projectId, standing, began)) {
    if (toldHolders(ask.door)) {
      return `the holders of the act ${key} waits on were asked about it on this standing (${ask.at.toISOString()}). Ask nothing until its standing moves; write the note.`;
    }
    if (ask.settledAt === null) {
      return `the master's ask about ${key} on this standing (${ask.at.toISOString()}) still stands. Ask nothing more; write the note.`;
    }
  }
  return null;
}

/** The id of the item a key names in the project, or null where it names none any more. */
async function itemIdOf(projectId: string, key: string): Promise<string | null> {
  try {
    return (await decisionSubjectOf(projectId, key)).id;
  } catch {
    return null;
  }
}

/**
 * The open asks a reasoned decision answered since they were made (ISS-739): one recorded at or after
 * the ask, on an item `answeredOnOf` names, that still holds at `now`. The master's nudge leaves
 * them out as soon as the decision is written, rather than listing them again until the sweep
 * settles them. A decision made before the ask on its standing never let it be made (`askedAlready`).
 */
export async function answeredAsks(
  projectId: string,
  asks: readonly AskRow[],
  now: Date,
): Promise<Set<string>> {
  if (asks.length === 0) return new Set();
  const ids = new Map<string, string | null>();
  const itemsOf = new Map<string, string[]>();
  const byKind = new Map<StandingSubjectKind, Set<string>>();
  for (const ask of asks) {
    const items: string[] = [];
    for (const on of answeredOnOf(ask)) {
      if (!ids.has(on.key)) {
        const own = on.key === ask.subjectKey.toUpperCase();
        ids.set(on.key, own ? ask.subjectId : await itemIdOf(projectId, on.key));
      }
      const id = ids.get(on.key);
      if (!id) continue;
      items.push(id);
      byKind.set(on.kind, (byKind.get(on.kind) ?? new Set()).add(id));
    }
    itemsOf.set(ask.id, items);
  }
  const steward = await heldStewardOf(projectId);
  const decided = new Map<string, AskAnswer[]>();
  for (const [kind, kindIds] of byKind) {
    for (const d of await decisionsOn(kind, [...kindIds], steward ? [steward] : [])) {
      decided.set(d.subjectId, [...(decided.get(d.subjectId) ?? []), d]);
    }
  }
  const answered = (ask: AskRow) =>
    (itemsOf.get(ask.id) ?? []).some((id) =>
      (decided.get(id) ?? []).some((d) => holds(d, now) && d.at >= ask.at),
    );
  return new Set(asks.filter(answered).map((ask) => ask.id));
}

/**
 * Of the open asks of the master, those to settle: the ones whose item's standing moved off them
 * (its wait ended, a new one began, or a run read it on another basis), the ones whose item now
 * waits on a person, whose act the master does not take (ISS-739), the ones a decision recorded on
 * that standing answered, before the ask or after, and the ones `answeredAsks` reads answered on
 * the item it is about or on its run's own.
 */
export async function asksToSettle(
  projectId: string,
  open: readonly AskRow[],
  rows: readonly ItemStanding[],
  now: Date,
): Promise<string[]> {
  const byKey = new Map(rows.map((r) => [r.subject.key.toUpperCase(), r]));
  const since = await answeredAsks(projectId, open, now);
  const out: string[] = [];
  const answered = new Map<string, boolean>();
  for (const ask of open) {
    const standing = byKey.get(aboutKeyOf(ask));
    if (!standing || since.has(ask.id) || waitsOnPerson(standing)) {
      out.push(ask.id);
      continue;
    }
    const began = await standingBeganAt(standing);
    const off =
      !onStanding(ask.at, began) ||
      (ask.subjectId === standing.subject.id && ask.basis !== standing.basis);
    if (off) {
      out.push(ask.id);
      continue;
    }
    const key = standing.subject.key;
    if (!answered.has(key)) {
      answered.set(key, (await answerOf(projectId, standing, now, began)) !== null);
    }
    if (answered.get(key)) out.push(ask.id);
  }
  return out;
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
