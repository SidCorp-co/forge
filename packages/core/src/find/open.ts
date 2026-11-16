// Opening one hit of the find door (ISS-1256): the record its id names, read whole where the reader
// reads its project, with the web path that shows it. What it returns is what the opener's read
// records (ISS-1251 §3's read signal, `run-context`), so a module tree can say how often agents read
// a node. An id naming nothing the reader reads is refused by name, never answered empty.

import { FIND_TYPES, type FindOpened, type FindType } from '@forge/contracts/find';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  comments,
  issues,
  knowledgeEntries,
  memories,
  orgKnowledgeEntries,
  projects,
  referenceSources,
} from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { issueDisplayIds } from '../issues/index.js';
import { doorCatalog } from '../lib/door-catalog.js';
import { refuser } from '../lib/refusal.js';
import type { Found } from '../run-context/index.js';
import type { Candidate } from './candidate.js';
import { moduleTree, placementsOf, relationsOf } from './model-reads.js';
import { fuseArms, hitOf } from './rank.js';
import { openPathOf } from './service.js';

const refuse = refuser<'FIND_HIT_ID_INVALID' | 'FIND_HIT_NOT_FOUND'>('FIND_HIT_NOT_FOUND');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A hit id as its type and ref, or the refusal naming the shape an id takes. */
export function parseHitId(id: string): { type: FindType; ref: string } {
  const at = id.indexOf(':');
  const type = id.slice(0, at) as FindType;
  const ref = id.slice(at + 1);
  const uuid = ref.startsWith('org:') ? ref.slice(4) : ref;
  const refOk = type === 'capability' ? ref.length > 0 : UUID.test(uuid);
  if (at < 1 || !FIND_TYPES.includes(type) || !refOk) {
    throw refuse(
      'FIND_HIT_ID_INVALID',
      `\`${id.slice(0, 80)}\` is no hit id: an id is <type>:<ref> as a find answered it, the type one of ${FIND_TYPES.join(', ')}`,
      '/id',
    );
  }
  return { type, ref };
}

/** What one opened record is, before it is shaped as a hit. */
interface Loaded {
  candidate: Omit<Candidate, 'id' | 'type' | 'ref' | 'arm' | 'score'>;
  /** The web path under the project's own (`/projects/<slug>`), or an absolute one. */
  path: (slug: string) => string;
  found: Found;
}

type Loader = (ref: string, projectIds: readonly string[]) => Promise<Loaded | null>;

const knowledgeLoader: Loader = async (ref, projectIds) => {
  if (ref.startsWith('org:')) {
    const [row] = await db
      .select({ entry: orgKnowledgeEntries })
      .from(orgKnowledgeEntries)
      .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
      .where(and(eq(orgKnowledgeEntries.id, ref.slice(4)), inArray(projects.id, [...projectIds])))
      .limit(1);
    if (!row) return null;
    const e = row.entry;
    return {
      candidate: {
        key: e.slug,
        title: e.title,
        text: e.body,
        projectId: null,
        status: 'in force',
        placed: null,
      },
      path: () => '/org',
      found: { knowledge: [{ slug: e.slug, kind: 'rule', updatedAt: e.updatedAt, body: e.body }] },
    };
  }
  const [e] = await db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, ref), inArray(knowledgeEntries.projectId, [...projectIds])));
  if (!e) return null;
  return {
    candidate: {
      key: e.slug,
      title: e.title,
      text: e.body,
      projectId: e.projectId,
      status: e.archivedAt ? 'retired' : 'in force',
      placed: { kind: 'knowledge', id: e.id },
    },
    path: (slug) => `/projects/${slug}/memory`,
    found: { knowledge: [{ slug: e.slug, kind: e.kind, updatedAt: e.updatedAt, body: e.body }] },
  };
};

const issueLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, ref), inArray(issues.projectId, [...projectIds])));
  if (!row) return null;
  const key = (await issueDisplayIds([row.id])).get(row.id) ?? null;
  const text = row.description ?? '';
  return {
    candidate: {
      key,
      title: row.title,
      text,
      projectId: row.projectId,
      status: row.status,
      placed: { kind: 'issue', id: row.id },
    },
    path: (slug) => `/projects/${slug}/issues/${row.id}`,
    found: { records: [{ kind: 'issue', ref: row.id, text: `${row.title}\n${text}` }] },
  };
};

const requirementLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, ref), inArray(requirements.projectId, [...projectIds])));
  if (!row) return null;
  const [revision] = await db
    .select()
    .from(requirementRevisions)
    .where(
      row.currentRevision === null
        ? eq(requirementRevisions.requirementId, row.id)
        : and(
            eq(requirementRevisions.requirementId, row.id),
            eq(requirementRevisions.revision, row.currentRevision),
          ),
    )
    .orderBy(desc(requirementRevisions.revision))
    .limit(1);
  const text = [revision?.tldr, revision ? JSON.stringify(revision.spec, null, 2) : null]
    .filter(Boolean)
    .join('\n\n');
  return {
    candidate: {
      key: `REQ-${row.reqSeq}`,
      title: row.title,
      text,
      projectId: row.projectId,
      status: row.status,
      placed: { kind: 'requirement', id: row.id },
    },
    path: (slug) => `/projects/${slug}/requirements/REQ-${row.reqSeq}`,
    found: { records: [{ kind: 'requirement', ref: row.id, text: `${row.title}\n${text}` }] },
  };
};

const feedbackLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.id, ref), inArray(feedback.projectId, [...projectIds])));
  if (!row) return null;
  const text = row.body ?? '';
  return {
    candidate: {
      key: `FB-${row.fbSeq}`,
      title: row.title,
      text,
      projectId: row.projectId,
      status: row.status,
      placed: null,
    },
    path: (slug) => `/projects/${slug}/feedback/FB-${row.fbSeq}`,
    found: { records: [{ kind: 'feedback', ref: row.id, text: `${row.title}\n${text}` }] },
  };
};

const memoryLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.id, ref),
        inArray(memories.projectId, [...projectIds]),
        isNull(memories.archivedAt),
      ),
    );
  if (!row) return null;
  return {
    candidate: {
      key: null,
      title: row.textContent.split('\n')[0]?.slice(0, 120) ?? '',
      text: row.textContent,
      projectId: row.projectId,
      status: null,
      placed: null,
    },
    path: (slug) => `/projects/${slug}/memory`,
    found: { memory: [{ id: row.id, asOf: row.updatedAt, text: row.textContent }] },
  };
};

const decisionLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select({ c: comments, i: issues.projectId, r: requirements.projectId, f: feedback.projectId })
    .from(comments)
    .leftJoin(issues, eq(issues.id, comments.issueId))
    .leftJoin(requirements, eq(requirements.id, comments.requirementId))
    .leftJoin(feedback, eq(feedback.id, comments.feedbackId))
    .where(and(eq(comments.id, ref), eq(comments.intent, 'decision')));
  const projectId = row ? (row.i ?? row.r ?? row.f) : null;
  if (!row || !projectId || !projectIds.includes(projectId)) return memoryLoader(ref, projectIds);
  const d = row.c.decision;
  const text = [d?.decision, d?.reason, row.c.body].filter(Boolean).join('\n\n');
  return {
    candidate: {
      key: null,
      title: d?.decision ?? row.c.body.slice(0, 120),
      text,
      projectId,
      status: null,
      placed: { kind: 'decision', id: row.c.id },
    },
    path: (slug) =>
      row.c.issueId ? `/projects/${slug}/issues/${row.c.issueId}` : `/projects/${slug}/modules`,
    found: { records: [{ kind: 'decision', ref: row.c.id, text }] },
  };
};

const referenceLoader: Loader = async (ref, projectIds) => {
  const [row] = await db
    .select({ s: referenceSources })
    .from(referenceSources)
    .innerJoin(projects, eq(projects.orgId, referenceSources.orgId))
    .where(and(eq(referenceSources.id, ref), inArray(projects.id, [...projectIds])))
    .limit(1);
  const s = row?.s;
  if (!s || (s.projectId && !projectIds.includes(s.projectId))) return null;
  const text = `${s.url}\n\n${s.why}`;
  return {
    candidate: {
      key: null,
      title: s.title,
      text,
      projectId: s.projectId,
      status: s.kind,
      placed: { kind: 'reference', id: s.id },
    },
    path: (slug) => `/projects/${slug}/modules`,
    found: { records: [{ kind: 'reference', ref: s.id, text }] },
  };
};

const capabilityLoader: Loader = async (ref) => {
  const card = doorCatalog().doors.find((d) => d.card?.id === ref)?.card;
  if (!card) return null;
  const text = [
    card.purpose,
    ...card.situations.map((s) => `When ${s.when} → ${s.do}`),
    ...card.practice,
    ...(card.redFlag ? [`Red flag: ${card.redFlag}`] : []),
  ].join('\n');
  return {
    candidate: {
      key: card.id,
      title: card.purpose,
      text,
      projectId: null,
      status: null,
      placed: { kind: 'capability', id: card.id },
    },
    path: (slug) => `/projects/${slug}/modules`,
    found: { records: [{ kind: 'capability', ref: card.id, text }] },
  };
};

const LOADERS: Record<FindType, Loader | null> = {
  term: knowledgeLoader,
  rule: knowledgeLoader,
  lesson: knowledgeLoader,
  knowledge: knowledgeLoader,
  issue: issueLoader,
  requirement: requirementLoader,
  feedback: feedbackLoader,
  memory: memoryLoader,
  decision: decisionLoader,
  reference: referenceLoader,
  capability: capabilityLoader,
  // a passage is read in its room, through the transcript its own fence guards
  conversation: null,
};

/** One hit opened in `projectId`, over the projects its reader reads, and what its read records. */
export async function openHit(input: {
  projectId: string;
  projectIds: readonly string[];
  id: string;
}): Promise<{ opened: FindOpened; found: Found; projectId: string }> {
  const { type, ref } = parseHitId(input.id);
  const load = LOADERS[type];
  const loaded = load ? await load(ref, input.projectIds) : null;
  if (!loaded) {
    throw refuse(
      'FIND_HIT_NOT_FOUND',
      `${input.id} names no ${type} in a project this reader reads${load ? '' : '; a conversation passage is read in its room'}`,
      '/id',
    );
  }
  const candidate: Candidate = {
    ...loaded.candidate,
    id: input.id,
    type,
    ref,
    arm: 'keyword',
    score: 0,
  };
  const [fused] = fuseArms([{ arm: 'keyword', hits: [candidate] }]);
  const projectOf = candidate.projectId ?? input.projectId;
  const [modules, placed, slugRow] = await Promise.all([
    moduleTree(input.projectIds),
    candidate.placed
      ? placementsOf(candidate.placed.kind, [candidate.placed.id], input.projectId)
      : new Map(),
    db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, projectOf)),
  ]);
  const slug = slugRow[0]?.slug ?? '';
  const label = candidate.placed ? placed.get(candidate.placed.id) : undefined;
  const hit = hitOf(fused ?? { ...candidate, arms: [], matchedAlias: null }, {
    modules,
    placements: new Map(label ? [[input.id, label]] : []),
    projectSlugs: new Map([[projectOf, slug]]),
    openPath: (id) => openPathOf(input.projectId, id),
  });
  const path = loaded.path(slug);
  const relations =
    (type === 'term' || type === 'rule') && candidate.projectId && candidate.key
      ? await relationsOf({ id: ref, projectId: candidate.projectId, slug: candidate.key, type })
      : [];
  return {
    opened: {
      hit: { ...hit, match: { arms: [], alias: null }, score: 0 },
      url: path,
      text: candidate.text,
      relations,
    },
    found: loaded.found,
    projectId: projectOf,
  };
}
