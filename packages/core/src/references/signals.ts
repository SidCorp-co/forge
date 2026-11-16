// Whether a project's reference sources are used, and which are up for review (ISS-1252): per source,
// its citations (taken and rejected), the ideas its releases filed and what became of them, its last
// release, and a flag where it is archived upstream, unmaintained, or uncited for 90 days. A flag is
// shown for a person to keep, replace or remove the source; nothing is removed by it.

import {
  REFERENCE_REVIEW_OPTIONS,
  REFERENCE_UNCITED_DAYS,
  REFERENCE_UNMAINTAINED_DAYS,
  type ReferenceFlagKind,
  type ReferenceSignalsResponse,
  type ReferenceSourceSignals,
} from '@forge/contracts/references';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { referenceCitations } from '../db/schema-references.js';
import { rowIn as feedbackRowIn, linkedOf, phaseIn } from '../feedback/index.js';
import { activeSourcesOf, ideasBySource, orgOfProject, type SourceRow } from './read.js';

const DAY = 86_400_000;

interface CitationFacts {
  total: number;
  recent: number;
  lastAt: Date | null;
}

/**
 * The flags a source stands under at `now`: `archived` where its repository is, `unmaintained` where
 * a followed repository neither released nor was pushed for REFERENCE_UNMAINTAINED_DAYS, and
 * `uncited` where it was added more than REFERENCE_UNCITED_DAYS ago and nobody cited it since.
 */
export function flagsOf(
  source: Pick<
    SourceRow,
    'addedAt' | 'followReleases' | 'repoArchived' | 'repoPushedAt' | 'lastReleaseAt'
  >,
  citations: Pick<CitationFacts, 'lastAt'>,
  now: Date,
): { kind: ReferenceFlagKind; detail: string }[] {
  const flags: { kind: ReferenceFlagKind; detail: string }[] = [];
  if (source.repoArchived) {
    flags.push({ kind: 'archived', detail: 'its repository is archived upstream' });
  }
  const active = [source.repoPushedAt, source.lastReleaseAt]
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((a, b) => (a && a > b ? a : b), null);
  if (
    source.followReleases &&
    active &&
    now.getTime() - active.getTime() > REFERENCE_UNMAINTAINED_DAYS * DAY
  ) {
    flags.push({
      kind: 'unmaintained',
      detail: `no release or push since ${active.toISOString().slice(0, 10)}`,
    });
  }
  const since = citations.lastAt ?? source.addedAt;
  if (now.getTime() - since.getTime() > REFERENCE_UNCITED_DAYS * DAY) {
    flags.push({
      kind: 'uncited',
      detail: citations.lastAt
        ? `last cited ${citations.lastAt.toISOString().slice(0, 10)}`
        : `never cited since it was added on ${source.addedAt.toISOString().slice(0, 10)}`,
    });
  }
  return flags;
}

/** Each source's citations in `projectId`: how many, how many recent, taken, rejected, the last. */
async function citationsOf(projectId: string, sourceIds: readonly string[], now: Date) {
  const out = new Map<string, CitationFacts & { taken: number; rejected: number }>();
  if (sourceIds.length === 0) return out;
  const rows = await db
    .select({
      sourceId: referenceCitations.sourceId,
      verdict: referenceCitations.verdict,
      citedAt: referenceCitations.citedAt,
    })
    .from(referenceCitations)
    .where(
      and(
        eq(referenceCitations.projectId, projectId),
        inArray(referenceCitations.sourceId, [...sourceIds]),
      ),
    );
  const recentSince = now.getTime() - REFERENCE_UNCITED_DAYS * DAY;
  for (const r of rows) {
    const c = out.get(r.sourceId) ?? { total: 0, recent: 0, taken: 0, rejected: 0, lastAt: null };
    c.total += 1;
    if (r.citedAt.getTime() >= recentSince) c.recent += 1;
    if (r.verdict === 'take') c.taken += 1;
    else c.rejected += 1;
    if (!c.lastAt || r.citedAt > c.lastAt) c.lastAt = r.citedAt;
    out.set(r.sourceId, c);
  }
  return out;
}

const TAKEN = new Set(['planned', 'resolved', 'verified']);
const OPEN = new Set(['new', 'triaged', 'reopened']);

/** What became of the ideas each source filed: open, taken into work, or declined. */
async function ideaPhasesOf(projectId: string, sourceIds: readonly string[]) {
  const bySource = await ideasBySource(projectId, sourceIds);
  const ids = [...new Set([...bySource.values()].flat())];
  const rows = await Promise.all(ids.map((id) => feedbackRowIn(db, projectId, id)));
  const linked = await linkedOf(projectId, rows);
  const phase = new Map(rows.map((r) => [r.id, phaseIn(r, linked)]));
  const out = new Map<string, ReferenceSourceSignals['ideas']>();
  for (const [sourceId, filed] of bySource) {
    const phases = filed.map((id) => phase.get(id) ?? 'new');
    out.set(sourceId, {
      filed: filed.length,
      open: phases.filter((p) => OPEN.has(p)).length,
      taken: phases.filter((p) => TAKEN.has(p)).length,
      declined: phases.filter((p) => p === 'declined').length,
    });
  }
  return out;
}

/** `GET /api/projects/:id/reference-sources/signals`. */
export async function referenceSignals(
  projectId: string,
  now: Date = new Date(),
): Promise<ReferenceSignalsResponse> {
  const orgId = await orgOfProject(projectId);
  const sources = await activeSourcesOf(db, projectId, orgId);
  const ids = sources.map((s) => s.id);
  const [citations, ideas] = await Promise.all([
    citationsOf(projectId, ids, now),
    ideaPhasesOf(projectId, ids),
  ]);
  return {
    sources: sources.map((s) => {
      const c = citations.get(s.id) ?? { total: 0, recent: 0, taken: 0, rejected: 0, lastAt: null };
      return {
        id: s.id,
        scope: s.projectId === null ? 'org' : 'project',
        title: s.title,
        url: s.url,
        kind: s.kind,
        areas: s.areas,
        followReleases: s.followReleases,
        addedAt: s.addedAt.toISOString(),
        citations: { ...c, lastAt: c.lastAt ? c.lastAt.toISOString() : null },
        ideas: ideas.get(s.id) ?? { filed: 0, open: 0, taken: 0, declined: 0 },
        lastRelease: s.lastSeenTag
          ? { tag: s.lastSeenTag, at: s.lastReleaseAt ? s.lastReleaseAt.toISOString() : null }
          : null,
        flags: flagsOf(s, c, now),
      };
    }),
    window: { uncitedDays: REFERENCE_UNCITED_DAYS, unmaintainedDays: REFERENCE_UNMAINTAINED_DAYS },
    review: REFERENCE_REVIEW_OPTIONS,
  };
}
