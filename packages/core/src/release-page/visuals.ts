// What each New and Fixed line of a release page shows (ISS-1308): the clip or shots its judge marked
// on a pass of its issue (`issues/criteria/release-visual-mark.ts`), with no requirement involved;
// the lines that touched a screen and show none, counted for the developer view and never refused;
// and the card a master's release post carries. Core picks no file: it reads the judges' marks.

import {
  type ReleaseLineVisual,
  type ReleasePage,
  type ReleaseVisualFile,
  releaseMediaKindOf,
} from '@forge/contracts/release-page';
import {
  type ReleaseCard,
  type ReleaseVisualsOwed,
  releaseCardOf,
} from '@forge/contracts/release-visual';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import { env } from '../lib/env.js';
import { findProjectSlugs } from '../projects/index.js';

type Change = ReleasePage['improvements'][number];
type Changes = { improvements: Change[]; fixes: Change[] };

interface MarkRow extends Record<string, unknown> {
  issue_id: string;
  n: number;
  v_id: string;
  desktop: string | null;
  phone: string | null;
  still: string | null;
  seconds: number | null;
}

/** What the judges marked of each issue, and the issues a judge said shows no clip. */
export interface LineVisualFacts {
  /** The newest marked visual of each issue, by issue id. */
  visuals: Map<string, ReleaseLineVisual>;
  /** Issues one of whose verdicts says why it cites no clip (`withoutClip`). */
  saidNone: Set<string>;
}

const listOf = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * The newest pass of each issue marking a visual, on a live criterion whose latest verdict is not a
 * fail: a re-judge that only restates a pass keeps the mark, and a fail since takes it down.
 */
async function markRows(issueIds: readonly string[]): Promise<MarkRow[]> {
  const issues = listOf(issueIds);
  return (await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (v.criterion_id) v.criterion_id, v.verdict
        FROM criterion_verdicts v
        JOIN issue_criteria c ON c.id = v.criterion_id
       WHERE c.issue_id IN (${issues}) AND c.retired_at IS NULL
       ORDER BY v.criterion_id, v.created_at DESC, v.id DESC
    )
    SELECT DISTINCT ON (c.issue_id) c.issue_id::text AS issue_id, c.n, v.id::text AS v_id,
           v.visual_desktop_id::text AS desktop, v.visual_phone_id::text AS phone,
           v.visual_still_id::text AS still, v.visual_seconds AS seconds
      FROM criterion_verdicts v
      JOIN issue_criteria c ON c.id = v.criterion_id
      JOIN latest l ON l.criterion_id = v.criterion_id
     WHERE c.issue_id IN (${issues}) AND c.retired_at IS NULL
       AND v.verdict = 'pass' AND l.verdict <> 'fail'
       AND (v.visual_desktop_id IS NOT NULL OR v.visual_phone_id IS NOT NULL)
     ORDER BY c.issue_id, v.created_at DESC, v.id DESC`)) as unknown as MarkRow[];
}

async function saidNoneOf(issueIds: readonly string[]): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT c.issue_id::text AS issue_id
      FROM criterion_verdicts v
      JOIN issue_criteria c ON c.id = v.criterion_id
     WHERE c.issue_id IN (${listOf(issueIds)}) AND c.retired_at IS NULL
       AND coalesce(v.without_clip, '') ~ '[^[:space:]]'`)) as unknown as { issue_id: string }[];
  return new Set(rows.map((r) => r.issue_id));
}

/** Each marked file as a page shows it; a file gone, or one no page shows, reads as none. */
async function filesOf(ids: readonly string[]): Promise<Map<string, ReleaseVisualFile>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: issueAttachments.id,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      size: issueAttachments.size,
    })
    .from(issueAttachments)
    .where(inArray(issueAttachments.id, [...ids]));
  return new Map(
    rows.flatMap((r) => {
      const kind = releaseMediaKindOf(r.mime);
      if (!kind || r.size <= 0) return [];
      const file: ReleaseVisualFile = {
        attachmentId: r.id,
        name: r.name.slice(0, 180),
        kind,
        mime: r.mime as ReleaseVisualFile['mime'],
        bytes: r.size,
      };
      return [[r.id, file] as const];
    }),
  );
}

/**
 * What the judges of these issues marked, and which said none shows; that is read only where
 * `owedCounted`, as only the developer view counts owed visuals.
 */
export async function lineVisualsOf(
  issueIds: readonly string[],
  owedCounted: boolean,
): Promise<LineVisualFacts> {
  if (issueIds.length === 0) return { visuals: new Map(), saidNone: new Set() };
  const [rows, saidNone] = await Promise.all([
    markRows(issueIds),
    owedCounted ? saidNoneOf(issueIds) : new Set<string>(),
  ]);
  const files = await filesOf([
    ...new Set(rows.flatMap((r) => [r.desktop, r.phone, r.still].filter((x) => x !== null))),
  ]);
  const at = (id: string | null) => (id ? (files.get(id) ?? null) : null);
  const visuals = new Map<string, ReleaseLineVisual>();
  for (const r of rows) {
    const desktop = at(r.desktop);
    const phone = at(r.phone);
    if (!desktop && !phone) continue;
    visuals.set(r.issue_id, {
      desktop,
      phone,
      still: at(r.still),
      seconds: r.seconds,
      verdictId: r.v_id,
      criterion: Number(r.n),
    });
  }
  return { visuals, saidNone };
}

/** A visual with each file behind `link(attachmentId)`, or with its link taken out where that is null. */
export async function relinkedVisual(
  visual: ReleaseLineVisual | null | undefined,
  link: (attachmentId: string) => Promise<string | null> | string | null,
): Promise<ReleaseLineVisual | null> {
  if (!visual) return null;
  const at = async (f: ReleaseVisualFile | null) => {
    if (!f) return null;
    const { url: _url, ...file } = f;
    const url = await link(file.attachmentId);
    return url ? { ...file, url } : file;
  };
  return {
    ...visual,
    desktop: await at(visual.desktop),
    phone: await at(visual.phone),
    still: await at(visual.still),
  };
}

/** The link a signed-in reader fetches an attachment by. */
const downloadOf = (attachmentId: string) => `/api/attachments/${attachmentId}/download`;

/** Whether an issue's landing touched a screen: null where its landing names nothing to tell by. */
function touchedUi(issue: ReleaseDetail['issues'][number] | undefined): boolean | null {
  if (!issue) return null;
  if (issue.surfaces.includes('ui')) return true;
  return issue.landing.kind === 'named' ? false : null;
}

/**
 * Each line with the visual its issue's judge marked, linked for a signed-in reader, and, on the
 * developer view, the lines whose landing touched `ui` surfaces that show none and whose judge said
 * no why: counted, never refused.
 */
export async function withVisuals<T extends Changes>(
  detail: Pick<ReleaseDetail, 'issues'>,
  changes: T,
  view: ReleasePage['view'],
): Promise<T & { visualsOwed: ReleaseVisualsOwed | null }> {
  const byKey = new Map(detail.issues.map((i) => [i.key, i] as const));
  const facts = await lineVisualsOf(
    detail.issues.map((i) => i.id),
    view === 'developer',
  );
  const on = async (c: Change): Promise<Change> => {
    const issue = byKey.get(c.issueKey);
    const marked = issue ? facts.visuals.get(issue.id) : undefined;
    return { ...c, visual: await relinkedVisual(marked, downloadOf), ui: touchedUi(issue) };
  };
  const improvements = await Promise.all(changes.improvements.map(on));
  const fixes = await Promise.all(changes.fixes.map(on));
  return {
    ...changes,
    improvements,
    fixes,
    visualsOwed:
      view === 'developer' ? visualsOwedOf(detail, { improvements, fixes }, facts) : null,
  };
}

/** The lines that touched a screen and show nothing, with no why from their judge (ISS-1308). */
export function visualsOwedOf(
  detail: Pick<ReleaseDetail, 'issues'>,
  changes: Changes,
  facts: Pick<LineVisualFacts, 'saidNone'>,
): ReleaseVisualsOwed {
  const byKey = new Map(detail.issues.map((i) => [i.key, i] as const));
  const owes = (c: Change) => {
    const issue = byKey.get(c.issueKey);
    if (!issue?.surfaces.includes('ui')) return false;
    return !c.visual && !facts.saidNone.has(issue.id);
  };
  const lines = [
    ...changes.improvements.filter(owes).map((c) => ({ c, kind: 'new' as const })),
    ...changes.fixes.filter(owes).map((c) => ({ c, kind: 'fixed' as const })),
  ].map(({ c, kind }) => ({ issueKey: c.issueKey, line: c.line, kind }));
  return { count: lines.length, lines };
}

/** The card a master's release post carries, linking the release's page in the app. */
export async function cardOf(
  projectId: string,
  page: Pick<ReleasePage, 'header' | 'improvements' | 'fixes'>,
): Promise<ReleaseCard> {
  const slug = (await findProjectSlugs([projectId])).get(projectId) ?? projectId;
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  const link = `${base}/projects/${encodeURIComponent(slug)}/releases/${encodeURIComponent(page.header.version)}`;
  return releaseCardOf(page, link);
}
