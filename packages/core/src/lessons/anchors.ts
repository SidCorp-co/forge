/**
 * Nothing a lesson says outlives what it is about (ISS-1251 §5). A lesson names its anchor: a
 * capability card, a requirement's behaviour or code. When a landing touches the anchor, the lesson is
 * invalidated in that landing's own consumer: held, kept for its history, out of every map and search,
 * and owed the steward's re-check (`steward/lessons-lifecycle.ts`). A card anchor also marks the card
 * owed a re-check (`card-freshness.ts`).
 *
 * A code anchor is met by a changed path (the file, or one under its directory); a requirement's
 * behaviour by the landing's own words naming it; a card by the paths its door lives in, or by the
 * landing naming the card. A test changes no symbol, door or behaviour, and neither does a file
 * changed in its layout alone (whitespace, line breaks, a trailing comma, as the box read it), so
 * neither meets an anchor (ISS-1251: ISS-1251's own test edits and one rewrapped throw in
 * `tool-description.ts` held ten lessons).
 */

import { landsMerge } from '@forge/contracts/issue-machine';
import { lessonAnchorKind } from '@forge/contracts/lessons';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { lessons } from '../db/schema-lessons.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { markCardRecheckOwed } from './card-freshness.js';
import { invalidateLessonIn, lockLessons } from './decide.js';
import { lessonsPorts } from './ports.js';

/** One landing as an anchor is weighed against it. */
export interface AnchorChange {
  /** The landing's key (`ISS-12`). */
  by: string;
  /** The paths it changed; empty where they could not be read. */
  paths: readonly string[];
  /** Of `paths`, those changed in their layout alone; none where the box did not read them so. */
  formatOnly?: readonly string[];
  /** Its own words: title, description, plan, release notes. */
  text: string;
}

const pathOf = (anchor: string) => anchor.replace(/:[A-Za-z_$][\w$.]*$/, '').replace(/\/+$/, '');

/** Whether a changed path is the anchor's file or lies under it. */
const pathMeets = (anchor: string, changed: string) => {
  const a = pathOf(anchor);
  return changed === a || changed.endsWith(`/${a}`) || changed.startsWith(`${a}/`);
};

/** A test or a test's fixture: a file the build serves nothing from. */
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec|fixture)\.[cm]?[jt]sx?$/;

/** What of the change meets the anchor, as named; empty where nothing does. */
export function anchorMet(
  anchor: string,
  landing: AnchorChange,
  cardPaths: readonly string[] = [],
): string[] {
  const kind = lessonAnchorKind(anchor);
  // a lesson anchored to a test itself is still met by that test's change; a reformat meets none
  const own = kind === 'code' ? pathOf(anchor) : null;
  const reformatted = new Set(landing.formatOnly ?? []);
  const change = {
    ...landing,
    paths: landing.paths.filter(
      (p) => !reformatted.has(p) && (!TEST_PATH.test(p) || (own !== null && pathMeets(own, p))),
    ),
  };
  if (kind === 'code') return change.paths.filter((p) => pathMeets(anchor, p));
  if (kind === 'bc') {
    const [req, bc] = anchor.split(' ');
    const named = new RegExp(`\\b${req}\\b[^\\n]{0,40}\\b${bc}\\b`);
    return named.test(change.text) ? [anchor] : [];
  }
  const id = anchor.slice('card:'.length);
  const byPath = change.paths.filter((p) => cardPaths.some((c) => pathMeets(c, p)));
  return byPath.length > 0 ? byPath : change.text.includes(id) ? [anchor] : [];
}

/**
 * Invalidate each approved lesson of the project whose anchor the change meets; how many. A card a
 * lesson is anchored to is marked owed a re-check, whether or not a lesson stood on it.
 */
export async function invalidateLessonsForChange(
  projectId: string,
  change: AnchorChange,
): Promise<number> {
  const anchored = await db
    .select()
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.status, 'approved'),
        isNotNull(lessons.anchor),
      ),
    );
  const ports = lessonsPorts();
  let invalidated = 0;
  for (const row of anchored) {
    const anchor = String(row.anchor);
    const isCard = lessonAnchorKind(anchor) === 'card';
    const cardPaths = isCard ? ((await ports.cardPaths?.(anchor.slice(5))) ?? []) : [];
    const met = anchorMet(anchor, change, cardPaths);
    if (met.length === 0) continue;
    const by = `${change.by} changed ${met.slice(0, 5).join(', ')}`;
    const done = await db.transaction(async (tx) => {
      await lockLessons(tx, projectId);
      return invalidateLessonIn(tx, row, by);
    });
    if (done) invalidated += 1;
    if (isCard) await markCardRecheckOwed(anchor.slice(5), by);
  }
  return invalidated;
}

/** A landing's invalidation, read through the change it landed; null where it landed nothing readable. */
export async function invalidateForLanding(
  projectId: string,
  issueId: string,
): Promise<number | null> {
  const landed = await lessonsPorts().landedChange(projectId, issueId);
  if (!landed) return null;
  if (landed.paths === null) {
    logger.info(
      { projectId, issueId, why: landed.why },
      'lessons: the landing paths were not read; weighing its words alone',
    );
  }
  return invalidateLessonsForChange(projectId, {
    by: landed.key,
    paths: landed.paths ?? [],
    formatOnly: landed.formatOnly ?? [],
    text: landed.text,
  });
}

export function registerLessonInvalidation(): void {
  consume('issue.transitioned', {
    name: 'lessons-invalidate',
    handle: async (p) => {
      if (!landsMerge(p)) return;
      await invalidateForLanding(p.projectId, p.id);
    },
  });
}
