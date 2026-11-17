/**
 * What the capabilities page reads beside a project's door use (ISS-1251 §7): the reports this
 * project's agents filed on a door (`forge-door/door-report.ts`, one feedback item per door and verdict
 * under `door:<verdict>:<door>`, each report an occurrence), the live lessons anchored to a card
 * (`card:<id>`, `lessons/anchors.ts`), each card's freshness (`lessons/card-freshness.ts`) and the
 * steward's last lessons pass on the project (`lessons/pass-report.ts`). Door
 * use, piles and the cards themselves are `door-use.ts` and `piles.ts`'s; this read answers only what
 * those leave out, over records Forge already keeps.
 */

import type {
  CapabilitiesView,
  CapabilityFeedbackRow,
  CapabilityFreshnessRow,
  CapabilityLessonRow,
} from '@forge/contracts/capabilities';
import { DOOR_REPORT_VERDICTS, type DoorReportVerdict } from '@forge/contracts/door-use';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { capabilitiesIn } from '../labels/index.js';
import { type CardFreshness, cardFreshness, lessonsPassReportOf } from '../lessons/index.js';

const DAY_MS = 86_400_000;

export const CAPABILITIES_LIMITS = [
  'A door report counts for this project where its reporter named the project it was in.',
  'Only a card id of letters, digits, dots and dashes can anchor a lesson, so a REST door holds none.',
];

const KEY = /^door:([a-z_]+):(.+)$/;

/** A report's signal key as its door and verdict, or null where it is no door report. */
export function doorReportKey(key: string): { door: string; verdict: DoorReportVerdict } | null {
  const m = KEY.exec(key);
  const verdict = m?.[1] as DoorReportVerdict | undefined;
  if (!m?.[2] || !verdict || !DOOR_REPORT_VERDICTS.includes(verdict)) return null;
  return { door: m[2], verdict };
}

type ReportRow = { key: string; n: number; last_at: Date | string };

const iso = (at: Date | string) => (at instanceof Date ? at : new Date(at)).toISOString();

/** Each door's reports from `rows` (one per signal key), most reported first. */
export function tallyReports(rows: readonly ReportRow[]): CapabilityFeedbackRow[] {
  const doors = new Map<string, CapabilityFeedbackRow>();
  for (const r of rows) {
    const read = doorReportKey(r.key);
    if (!read) continue;
    const row = doors.get(read.door) ?? { door: read.door, reports: 0, byVerdict: {}, lastAt: '' };
    row.reports += r.n;
    row.byVerdict[read.verdict] = (row.byVerdict[read.verdict] ?? 0) + r.n;
    const last = iso(r.last_at);
    if (last > row.lastAt) row.lastAt = last;
    doors.set(read.door, row);
  }
  return [...doors.values()].sort((a, b) => b.reports - a.reports || a.door.localeCompare(b.door));
}

async function reportRows(projectId: string, since: Date): Promise<ReportRow[]> {
  return (await db.execute(sql`
    SELECT f.signal_key AS key, count(o.id)::int AS n, max(o.created_at) AS last_at
    FROM feedback f JOIN feedback_occurrences o ON o.feedback_id = f.id
    WHERE f.signal_key LIKE 'door:%' AND o.source_project_id = ${projectId}::uuid
      AND o.created_at >= ${since.toISOString()}::timestamptz
    GROUP BY 1`)) as unknown as ReportRow[];
}

type LessonRow = {
  card: string;
  number: number;
  sentence: string;
  status: CapabilityLessonRow['status'];
  invalid_by: string | null;
  invalid: boolean;
  applied: number;
  last_applied_at: Date | string | null;
};

async function lessonRows(projectId: string): Promise<CapabilityLessonRow[]> {
  const rows = (await db.execute(sql`
    SELECT substr(l.anchor, 6) AS card, l.number, l.sentence, l.status, l.invalid_by,
      (l.invalid_at IS NOT NULL) AS invalid, l.applied_count AS applied, l.last_applied_at
    FROM lessons l
    WHERE l.project_id = ${projectId}::uuid AND l.anchor LIKE 'card:%'
      AND l.status IN ('proposed', 'approved', 'held')
    ORDER BY 1, l.number`)) as unknown as LessonRow[];
  return rows.map((r) => ({
    card: r.card,
    number: r.number,
    sentence: r.sentence,
    status: r.status,
    invalid: r.invalid,
    invalidBy: r.invalid_by,
    applied: r.applied,
    lastAppliedAt: r.last_applied_at === null ? null : iso(r.last_applied_at),
  }));
}

/**
 * A card's freshness as this project may read it: the re-check and the scenarios' outcomes (cards are
 * Forge's, shared by every project), and only the deltas this project's own lessons proposed.
 */
export function freshnessFor(
  projectId: string,
  rows: readonly CardFreshness[],
): CapabilityFreshnessRow[] {
  return rows
    .map((r) => ({
      card: r.cardId,
      recheckOwed: r.recheckOwed ? { since: r.recheckOwed.since } : null,
      scenarios: r.scenarios.map((s) => ({
        name: s.name,
        passed: s.passed,
        at: s.at,
        change: s.change,
        reason: s.reason,
      })),
      proposed: r.proposedDeltas
        .filter((d) => d.projectId === projectId)
        .map((d) => ({ field: d.field, text: d.text })),
    }))
    .filter((r) => r.recheckOwed || r.scenarios.length > 0 || r.proposed.length > 0);
}

export async function readCapabilities(
  projectId: string,
  days: number,
  now: Date = new Date(),
  module?: string,
): Promise<CapabilitiesView> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [reports, lessons, freshness, held, lessonsPass] = await Promise.all([
    reportRows(projectId, since),
    lessonRows(projectId),
    cardFreshness(),
    module ? capabilitiesIn(projectId, module) : Promise.resolve(null),
    lessonsPassReportOf(projectId),
  ]);
  // the module map's Capabilities branch (ISS-1256): every list narrowed to the module's own cards
  const cards = held ? new Set(held.cards) : null;
  const inModule = (card: string) => cards === null || cards.has(card);
  return {
    projectId,
    window: { days, since: since.toISOString(), until: now.toISOString() },
    feedback: tallyReports(reports).filter((r) => inModule(r.door)),
    lessons: lessons.filter((l) => inModule(l.card)),
    freshness: freshnessFor(projectId, freshness).filter((f) => inModule(f.card)),
    module: held ? { path: held.module, cards: held.cards } : null,
    lessonsPass,
    limits: CAPABILITIES_LIMITS,
  };
}
