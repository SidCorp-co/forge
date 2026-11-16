// The writes of a project's reference sources (ISS-1252): an add (a person's or an agent's), an
// agent's proposal of a source it kept using, a change, a removal kept for history, and a citation.
// Each runs in one transaction under the org's lock, so a duplicate check and its insert are one act,
// and answers its refusals rather than throwing them.

import type { ActorAgency } from '@forge/contracts/permissions';
import type {
  ReferenceAddRequest,
  ReferenceCiteRequest,
  ReferenceProposeRequest,
  ReferenceSourceView,
  ReferenceUpdateRequest,
} from '@forge/contracts/references';
import { and, eq, isNull, max } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { referenceCitations, referenceSources } from '../db/schema-references.js';
import { lockXact } from '../lib/advisory-lock.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { activeSourcesOf, type SourceRow, sourceIn, sourceView } from './read.js';
import { addressKey, duplicateRefusal, followRefusal, sharedRefusal, titleOf } from './rules.js';

export interface ReferenceActor {
  userId: string;
  agency: ActorAgency;
}

export type ReferenceOutcome<T> = ({ ok: true } & T) | { ok: false; refusals: Refusal[] };

/** `body` in one transaction under the org's lock; a refusal it returns rolls everything back. */
async function underOrg<T>(
  orgId: string,
  body: (tx: Tx) => Promise<Refusal[] | T>,
): Promise<ReferenceOutcome<T>> {
  try {
    const done = await db.transaction(async (tx) => {
      await lockXact(tx, 'referenceSources', orgId);
      const out = await body(tx);
      if (Array.isArray(out)) throw new RefusalError(out, 'REFERENCE_REFUSED');
      return out;
    });
    return { ok: true, ...done };
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, refusals: [...err.refusals] };
    throw err;
  }
}

const present = (r: Refusal | null): r is Refusal => r !== null;

/** The next priority of a scope: after every entry it holds. */
async function nextPriority(tx: Tx, orgId: string, projectId: string | null): Promise<number> {
  const [row] = await tx
    .select({ top: max(referenceSources.priority) })
    .from(referenceSources)
    .where(
      and(
        eq(referenceSources.orgId, orgId),
        projectId ? eq(referenceSources.projectId, projectId) : isNull(referenceSources.projectId),
        isNull(referenceSources.removedAt),
      ),
    );
  return Math.min(1000, (row?.top ?? 0) + 10);
}

type Entry = Omit<ReferenceAddRequest, 'shared'>;

async function insertSource(input: {
  projectId: string;
  actor: ReferenceActor;
  entry: Entry;
  shared: boolean;
  evidence: string | null;
}): Promise<ReferenceOutcome<{ act: 'added' | 'proposed'; source: ReferenceSourceView }>> {
  const { projectId, actor, entry, shared, evidence } = input;
  const access = await loadProjectAccess(projectId, actor.userId);
  const guards = [
    followRefusal(entry.url, entry.followReleases),
    shared ? sharedRefusal(access.orgRole) : null,
  ].filter(present);
  if (guards.length) return { ok: false, refusals: guards };
  return underOrg(access.orgId, async (tx) => {
    const held = (await activeSourcesOf(tx, projectId, access.orgId)).find(
      (r) => addressKey(r.url) === addressKey(entry.url),
    );
    const duplicate = duplicateRefusal(held);
    if (duplicate) return [duplicate];
    const scope = shared ? null : projectId;
    const [row] = await tx
      .insert(referenceSources)
      .values({
        orgId: access.orgId,
        projectId: scope,
        kind: entry.kind,
        url: entry.url.trim(),
        title: titleOf(entry.url, entry.title),
        why: entry.why,
        areas: [...new Set(entry.areas)],
        priority: entry.priority ?? (await nextPriority(tx, access.orgId, scope)),
        followReleases: entry.followReleases ?? false,
        origin: evidence === null ? 'added' : 'proposed',
        evidence,
        addedBy: actor.userId,
        addedAgency: actor.agency,
      })
      .returning();
    if (!row) throw new Error('references: the insert returned no row');
    return { act: evidence === null ? 'added' : 'proposed', source: sourceView(row) } as const;
  });
}

/** A person's or an agent's add; `shared` makes it the org's, for an org admin. */
export function addSource(input: {
  projectId: string;
  actor: ReferenceActor;
  request: ReferenceAddRequest;
}) {
  const { shared, ...entry } = input.request;
  return insertSource({ ...input, entry, shared: shared === true, evidence: null });
}

/** An agent's add of a source it kept using, recorded as its proposal with the work it helped. */
export function proposeSource(input: {
  projectId: string;
  actor: ReferenceActor;
  request: ReferenceProposeRequest;
}) {
  const { evidence, ...entry } = input.request;
  return insertSource({ ...input, entry, shared: false, evidence });
}

/** The entry `ref` names, where `actor` may write it: an org entry is its admin's. */
async function writable(
  tx: Tx,
  projectId: string,
  orgId: string,
  orgRole: Parameters<typeof sharedRefusal>[0],
  ref: string,
): Promise<SourceRow | Refusal[]> {
  const row = await sourceIn(tx, projectId, orgId, ref);
  const shared = row.projectId === null ? sharedRefusal(orgRole) : null;
  return shared ? [shared] : row;
}

export async function updateSource(input: {
  projectId: string;
  actor: ReferenceActor;
  ref: string;
  request: ReferenceUpdateRequest;
}): Promise<ReferenceOutcome<{ act: 'updated'; source: ReferenceSourceView }>> {
  const access = await loadProjectAccess(input.projectId, input.actor.userId);
  return underOrg(access.orgId, async (tx) => {
    const row = await writable(tx, input.projectId, access.orgId, access.orgRole, input.ref);
    if (Array.isArray(row)) return row;
    const follow = followRefusal(row.url, input.request.followReleases);
    if (follow) return [follow];
    const { areas, ...rest } = input.request;
    const [updated] = await tx
      .update(referenceSources)
      .set({
        ...rest,
        ...(areas ? { areas: [...new Set(areas)] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(referenceSources.id, row.id))
      .returning();
    if (!updated) throw new Error('references: the update returned no row');
    return { act: 'updated', source: sourceView(updated) } as const;
  });
}

/** Removed with its reason and kept, never served again; its citations and timeline stay. */
export async function removeSource(input: {
  projectId: string;
  actor: ReferenceActor;
  ref: string;
  reason: string;
}): Promise<ReferenceOutcome<{ act: 'removed'; source: ReferenceSourceView }>> {
  const access = await loadProjectAccess(input.projectId, input.actor.userId);
  return underOrg(access.orgId, async (tx) => {
    const row = await writable(tx, input.projectId, access.orgId, access.orgRole, input.ref);
    if (Array.isArray(row)) return row;
    const [removed] = await tx
      .update(referenceSources)
      .set({ removedAt: new Date(), removedBy: input.actor.userId, removedReason: input.reason })
      .where(eq(referenceSources.id, row.id))
      .returning();
    if (!removed) throw new Error('references: the removal returned no row');
    return { act: 'removed', source: sourceView(removed) } as const;
  });
}

/** One use of a source, recorded as it was said: what was read, taken or rejected, and why. */
export async function citeSource(input: {
  projectId: string;
  actor: ReferenceActor;
  ref: string;
  request: ReferenceCiteRequest;
}): Promise<{
  ok: true;
  act: 'cited';
  citation: { id: string; source: string; verdict: string; citedAt: string };
}> {
  const access = await loadProjectAccess(input.projectId, input.actor.userId);
  const row = await sourceIn(db, input.projectId, access.orgId, input.ref);
  const [cited] = await db
    .insert(referenceCitations)
    .values({
      projectId: input.projectId,
      sourceId: row.id,
      ref: input.request.ref,
      verdict: input.request.verdict,
      why: input.request.why,
      about: input.request.about ?? null,
      citedBy: input.actor.userId,
      citedAgency: input.actor.agency,
    })
    .returning();
  if (!cited) throw new Error('references: the citation insert returned no row');
  return {
    ok: true,
    act: 'cited',
    citation: {
      id: cited.id,
      source: row.title,
      verdict: cited.verdict,
      citedAt: cited.citedAt.toISOString(),
    },
  };
}
