/**
 * A capability card's freshness (ISS-1251 §5, §7), keyed by the card's id. A landing that touches what
 * a card-anchored lesson is about marks the card owed a re-check; a lesson that holds folds into its
 * card as one proposed delta (ADD or UPDATE, never a rewrite), which the card's code then carries; and
 * each replay of a change to a card's teaching leaves the last result of each of the card's scenarios.
 * The capabilities page reads all three per card (`cardFreshness`).
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { cardDeltas, cardRechecks, cardScenarioRuns, lessons } from '../db/schema-lessons.js';
import type { CardDelta, CardText } from './ports.js';

/** Mark the card owed a re-check; touched again, it keeps its first `owedSince` and names the newest change. */
export async function markCardRecheckOwed(cardId: string, by: string): Promise<void> {
  await db
    .insert(cardRechecks)
    .values({ cardId, owedBy: by.slice(0, 500) })
    .onConflictDoUpdate({ target: cardRechecks.cardId, set: { owedBy: by.slice(0, 500) } });
}

/** The re-check done: the card is no longer owed one. Whether it was. */
export async function clearCardRecheck(cardId: string): Promise<boolean> {
  const gone = await db
    .delete(cardRechecks)
    .where(eq(cardRechecks.cardId, cardId))
    .returning({ cardId: cardRechecks.cardId });
  return gone.length > 0;
}

/**
 * The steward's re-check of a card is done once no lesson anchored on it, in any project, still waits
 * held for its re-check after the change that touched it: then the card is cleared. Whether it was.
 */
export async function settleCardRecheck(cardId: string): Promise<boolean> {
  const [waiting] = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(
      and(
        eq(lessons.anchor, `card:${cardId}`),
        eq(lessons.status, 'held'),
        isNotNull(lessons.invalidAt),
      ),
    )
    .limit(1);
  return waiting ? false : clearCardRecheck(cardId);
}

/** A line as compared: case, spacing, an arrow's spelling, a leading "when" and end stops set aside. */
const normal = (line: string) =>
  line
    .toLowerCase()
    .replace(/->/g, '→')
    .replace(/\s+/g, ' ')
    .replace(/\s*→\s*/g, ' → ')
    .trim()
    .replace(/^when /, '')
    .replace(/[.;:!]+$/, '');

/** Each line a card's surfaces render: every situation ("when … → …" and its watch), practice line, red flag. */
function cardLines(card: CardText): string[] {
  return [
    ...card.situations.flatMap((s) => [`${s.when} → ${s.do}`, ...(s.watch ? [s.watch] : [])]),
    ...card.practice,
    ...(card.redFlag ? [card.redFlag] : []),
  ].map(normal);
}

/** The cards holding a delta this project's lessons proposed, not yet carried. */
export async function cardsWithProposedDeltas(projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ cardId: cardDeltas.cardId })
    .from(cardDeltas)
    .where(and(eq(cardDeltas.projectId, projectId), eq(cardDeltas.status, 'proposed')));
  return rows.map((r) => r.cardId).sort();
}

/**
 * The card's re-check of its proposed deltas: each whose line the card's current text carries is
 * marked applied, which takes it off the card's surfaces; the rest stay proposed. How many were.
 */
export async function applyCarriedDeltas(card: CardText): Promise<number> {
  const proposed = await db
    .select({ id: cardDeltas.id, text: cardDeltas.text })
    .from(cardDeltas)
    .where(and(eq(cardDeltas.cardId, card.id), eq(cardDeltas.status, 'proposed')));
  const lines = cardLines(card);
  const carried = proposed
    .filter((d) => {
      const line = normal(d.text);
      return line.length > 0 && lines.some((l) => l.includes(line));
    })
    .map((d) => d.id);
  if (carried.length === 0) return 0;
  await db.update(cardDeltas).set({ status: 'applied' }).where(inArray(cardDeltas.id, carried));
  return carried.length;
}

/** Keep one delta a lesson folded into its card, proposed until the card's code carries it; its id. */
export async function proposeCardDelta(
  cardId: string,
  delta: CardDelta,
  from: { projectId: string; lesson: string },
): Promise<string> {
  const [row] = await db
    .insert(cardDeltas)
    .values({
      cardId,
      field: delta.field,
      op: delta.op,
      text: delta.text,
      replaces: delta.op === 'update' ? (delta.replaces ?? null) : null,
      projectId: from.projectId,
      fromLesson: from.lesson,
    })
    .returning({ id: cardDeltas.id });
  if (!row) throw new Error('lessons: a card delta inserted no row');
  return row.id;
}

/** Keep the last replay of each named scenario of a card. */
export async function recordScenarioRuns(
  cardId: string,
  change: string,
  runs: readonly { scenario: string; passed: boolean; reason: string }[],
): Promise<void> {
  for (const r of runs) {
    const values = {
      cardId,
      scenario: r.scenario,
      passed: r.passed ? 1 : 0,
      change,
      reason: r.reason.slice(0, 2000),
    };
    await db
      .insert(cardScenarioRuns)
      .values(values)
      .onConflictDoUpdate({
        target: [cardScenarioRuns.cardId, cardScenarioRuns.scenario],
        set: { passed: values.passed, change, reason: values.reason, at: sql`now()` },
      });
  }
}

/** What the capabilities page shows of one card's freshness. */
export interface CardFreshness {
  cardId: string;
  /** Owed a re-check since a landing touched it, or null. */
  recheckOwed: { since: string; by: string } | null;
  /** The last replay of each scenario, by name. */
  scenarios: { name: string; passed: boolean; change: string; reason: string; at: string }[];
  /** Deltas lessons folded into it that its code does not carry yet. */
  proposedDeltas: {
    id: string;
    field: CardDelta['field'];
    op: CardDelta['op'];
    text: string;
    replaces: string | null;
    fromLesson: string;
    projectId: string | null;
    at: string;
  }[];
}

/** Each card's freshness, for the ids asked or every card any row names. */
export async function cardFreshness(cardIds?: readonly string[]): Promise<CardFreshness[]> {
  const [owed, runs, deltas] = await Promise.all([
    db
      .select()
      .from(cardRechecks)
      .where(cardIds ? inArray(cardRechecks.cardId, [...cardIds]) : undefined),
    db
      .select()
      .from(cardScenarioRuns)
      .where(cardIds ? inArray(cardScenarioRuns.cardId, [...cardIds]) : undefined),
    db
      .select()
      .from(cardDeltas)
      .where(
        and(
          eq(cardDeltas.status, 'proposed'),
          cardIds ? inArray(cardDeltas.cardId, [...cardIds]) : undefined,
        ),
      ),
  ]);
  const ids = new Set([
    ...(cardIds ?? []),
    ...owed.map((o) => o.cardId),
    ...runs.map((r) => r.cardId),
    ...deltas.map((d) => d.cardId),
  ]);
  return [...ids].sort().map((cardId) => {
    const o = owed.find((x) => x.cardId === cardId);
    return {
      cardId,
      recheckOwed: o ? { since: o.owedSince.toISOString(), by: o.owedBy } : null,
      scenarios: runs
        .filter((r) => r.cardId === cardId)
        .map((r) => ({
          name: r.scenario,
          passed: r.passed === 1,
          change: r.change,
          reason: r.reason,
          at: r.at.toISOString(),
        })),
      proposedDeltas: deltas
        .filter((d) => d.cardId === cardId)
        .map((d) => ({
          id: d.id,
          field: d.field,
          op: d.op,
          text: d.text,
          replaces: d.replaces,
          fromLesson: d.fromLesson,
          projectId: d.projectId,
          at: d.createdAt.toISOString(),
        })),
    };
  });
}
