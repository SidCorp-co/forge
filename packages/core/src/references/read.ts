// A project's reference sources as read (ISS-1252): its own entries and its org's, the project's
// first, each in priority order, filtered by an area or by words; one source by id, address or name;
// and a source's timeline of the releases the project read from it.

import type {
  ReferenceReleaseView,
  ReferenceSearchQuery,
  ReferenceSourceView,
} from '@forge/contracts/references';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { referenceReleases, referenceSources } from '../db/schema-references.js';
import { feedbackKeysOf } from '../feedback/index.js';
import { notFound } from '../middleware/route-errors.js';
import { findProjectOrgId } from '../projects/index.js';

export type SourceRow = typeof referenceSources.$inferSelect;
type Executor = Tx | typeof db;

/** The org of `projectId`; 404 where there is no such project. */
export async function orgOfProject(projectId: string): Promise<string> {
  const orgId = await findProjectOrgId(projectId);
  if (!orgId) throw notFound(`no project ${projectId}`);
  return orgId;
}

/** Every active entry `projectId` reads: its own and its org's, the project's first, by priority. */
export async function activeSourcesOf(
  ex: Executor,
  projectId: string,
  orgId: string,
): Promise<SourceRow[]> {
  const rows = await ex
    .select()
    .from(referenceSources)
    .where(
      and(
        eq(referenceSources.orgId, orgId),
        isNull(referenceSources.removedAt),
        or(eq(referenceSources.projectId, projectId), isNull(referenceSources.projectId)),
      ),
    )
    .orderBy(asc(referenceSources.priority), asc(referenceSources.addedAt));
  return [...rows.filter((r) => r.projectId !== null), ...rows.filter((r) => r.projectId === null)];
}

const isUuid = (ref: string) => z.uuid().safeParse(ref).success;

/**
 * The active entry `projectId` reads that `ref` names: its id, its address, or its name, as shown or
 * as `owner/name`; 404 naming the ref otherwise.
 */
export async function sourceIn(
  ex: Executor,
  projectId: string,
  orgId: string,
  ref: string,
): Promise<SourceRow> {
  const wanted = ref.trim().toLowerCase().replace(/\/+$/, '');
  const row = (await activeSourcesOf(ex, projectId, orgId)).find(
    (r) =>
      (isUuid(ref) && r.id === ref) ||
      r.url.toLowerCase().replace(/\/+$/, '') === wanted ||
      r.title.toLowerCase() === wanted,
  );
  if (!row) {
    throw notFound(
      `project ${projectId} reads no active reference source "${ref}": name one by its id, address or name (GET …/reference-sources lists them)`,
    );
  }
  return row;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function sourceView(r: SourceRow): ReferenceSourceView {
  return {
    id: r.id,
    scope: r.projectId === null ? 'org' : 'project',
    kind: r.kind,
    title: r.title,
    url: r.url,
    why: r.why,
    areas: r.areas,
    priority: r.priority,
    followReleases: r.followReleases,
    origin: r.origin,
    addedBy: r.addedBy,
    addedAgency: r.addedAgency,
    addedAt: r.addedAt.toISOString(),
    evidence: r.evidence,
    lastRelease: r.lastSeenTag ? { tag: r.lastSeenTag, at: iso(r.lastReleaseAt) } : null,
    lastCheckedAt: iso(r.lastCheckedAt),
    followError: r.followError,
  };
}

/** The words a source is found by: its name, address, why and areas. */
const haystackOf = (r: SourceRow) => [r.title, r.url, r.why, ...r.areas].join(' ').toLowerCase();

/**
 * The entries `projectId` reads, narrowed to those whose areas hold `area` (an area that contains it
 * or is contained in it) and whose words hold every word of `q`.
 */
export async function searchSources(
  projectId: string,
  query: ReferenceSearchQuery,
): Promise<ReferenceSourceView[]> {
  const orgId = await orgOfProject(projectId);
  const rows = await activeSourcesOf(db, projectId, orgId);
  const area = query.area?.toLowerCase();
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((r) => !area || r.areas.some((a) => a.includes(area) || area.includes(a)))
    .filter((r) => words.every((w) => haystackOf(r).includes(w)))
    .map(sourceView);
}

/** The releases `projectId` read from one of its sources, newest first. */
export async function timelineOf(
  projectId: string,
  ref: string,
  limit = 50,
): Promise<{ source: ReferenceSourceView; releases: ReferenceReleaseView[] }> {
  const orgId = await orgOfProject(projectId);
  const source = await sourceIn(db, projectId, orgId, ref);
  const rows = await db
    .select()
    .from(referenceReleases)
    .where(
      and(eq(referenceReleases.projectId, projectId), eq(referenceReleases.sourceId, source.id)),
    )
    .orderBy(desc(referenceReleases.readAt), desc(referenceReleases.publishedAt))
    .limit(limit);
  const ideaKeys = await feedbackKeysOf(rows.flatMap((r) => (r.feedbackId ? [r.feedbackId] : [])));
  return {
    source: sourceView(source),
    releases: rows.map((r) => ({
      tag: r.tag,
      name: r.name,
      url: r.url,
      publishedAt: iso(r.publishedAt),
      outcome: r.outcome,
      matched: r.matchedRef ? { ref: r.matchedRef, terms: r.matchedTerms ?? [] } : null,
      idea: r.feedbackId ? (ideaKeys.get(r.feedbackId)?.key ?? null) : null,
      readAt: r.readAt.toISOString(),
    })),
  };
}

/** The ids of the ideas each source filed for `projectId`, keyed by source. */
export async function ideasBySource(
  projectId: string,
  sourceIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (sourceIds.length === 0) return out;
  const rows = await db
    .select({ sourceId: referenceReleases.sourceId, feedbackId: referenceReleases.feedbackId })
    .from(referenceReleases)
    .where(
      and(
        eq(referenceReleases.projectId, projectId),
        inArray(referenceReleases.sourceId, [...sourceIds]),
        eq(referenceReleases.outcome, 'idea'),
      ),
    );
  for (const r of rows) {
    if (!r.feedbackId) continue;
    out.set(r.sourceId, [...(out.get(r.sourceId) ?? []), r.feedbackId]);
  }
  return out;
}
