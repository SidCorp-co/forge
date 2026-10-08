// MJ-1: the project's memory as a person reads it — what it says, who wrote it and when, whether
// anyone checked it, which records it names and which of those no longer resolve, why it needs a
// check, every correction or retirement a person made with their reason, and the text it held
// before each body that replaced it (ISS-434); with each list's
// count, read by the same rule. Behind `GET /api/memory/entries`. A person reads it on the record
// it names (REQ-33 BC-4): `cites` keeps the memories naming that one requirement, issue or workflow.
//
// Does NOT check authorization on the project — callers MUST verify project membership before
// invoking. `reader` decides which other projects a row's cites are read in (REQ-30 BC-10).

import {
  MEMORY_AUTHORED_SOURCES,
  MEMORY_CHECK_AFTER_DAYS,
  MEMORY_CHECK_REASONS,
  MEMORY_ENTRY_STATES,
  MEMORY_REVISIONS_SHOWN,
  type MemoryAct,
  type MemoryActor,
  type MemoryArchiveCause,
  type MemoryCheckReason,
  type MemoryCite,
  type MemoryEntry,
  type MemoryEntryState,
  type MemoryRevision,
} from '@forge/contracts/memory';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { memoryRevisions } from '../db/schema-memory-revisions.js';
import { peopleOf } from '../lib/people.js';
import { DECAY_FLAGGED, DECAY_UNUSED } from './decay.js';
import { memoryOfLiveIssue } from './live-issue.js';
import { memoryIssueReads } from './ports.js';
import { type Citations, type CiteReader, resolveCitations } from './stale-refs.js';

const NO_CITATIONS: Citations = { cites: [], staleRefs: [] };

/** An issue or requirement key as a memory names one (`stale-refs.ts:KEY_RE`, whole). */
const RECORD_KEY = /^[A-Z][A-Z0-9]{1,5}-\d{1,6}$/;
/** A workflow's flow as the text may name it: letters, digits, `-`, `_` and `.`, nothing a pattern reads. */
const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const MEMORY_CITES_SHAPE =
  'cites is an issue or requirement key (ISS-12, REQ-4) or a workflow flow (letters, digits, `.`, `_` and `-`)';

export const memoryCitesSchema = z
  .string()
  .trim()
  .refine((v) => RECORD_KEY.test(v) || FLOW_NAME.test(v), MEMORY_CITES_SHAPE);

/**
 * The rows whose text names `ref` as a whole word: not inside a longer key (`REQ-1` is not
 * `REQ-10`) nor a longer flow (`intake` is not `referral-intake`). A key reads by its case, a flow
 * by none. Which project a key's text places it in is known only once it resolves (`onlyCiting`).
 */
function namingWhere(ref: string): SQL {
  const escaped = ref.replace(/[.\\]/g, (c) => `\\${c}`);
  const pattern = `(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`;
  return RECORD_KEY.test(ref)
    ? sql`${memories.textContent} ~ ${pattern}`
    : sql`${memories.textContent} ~* ${pattern}`;
}

/** Whether a cite names a requirement, workflow or issue of the project itself. */
const namesAnItemOf = (self: string | undefined) => (x: MemoryCite) =>
  (x.kind === 'issue' || x.kind === 'requirement' || x.kind === 'workflow') && x.project === self;

async function selfSlug(projectId: string): Promise<string | undefined> {
  const projects = await memoryIssueReads().siblingProjects(projectId);
  return projects.find((p) => p.id === projectId)?.slug;
}

/** The rows naming no requirement, workflow or issue of this project: what the Dashboard lists. */
async function onlyUncited(projectId: string, rows: Checked[]): Promise<Checked[]> {
  const named = namesAnItemOf(await selfSlug(projectId));
  return rows.filter(({ c }) => !c.cites.some(named));
}

/** The rows that cite `ref` as this project's own record: a key placed in another project, or a word that is no workflow this project draws, is not one. */
async function onlyCiting(projectId: string, ref: string, rows: Checked[]): Promise<Checked[]> {
  const self = await selfSlug(projectId);
  const key = RECORD_KEY.test(ref);
  return rows.filter(({ c }) =>
    c.cites.some((x) =>
      key
        ? x.ref === ref && (x.kind === 'issue' || x.kind === 'requirement') && x.project === self
        : x.kind === 'workflow' && x.ref.toLowerCase() === ref.toLowerCase() && x.project === self,
    ),
  );
}

export const memoryEntriesInputSchema = z.object({
  projectId: z.uuid(),
  sources: z
    .array(z.enum(memorySources))
    .min(1)
    .default([...MEMORY_AUTHORED_SOURCES]),
  /** `live` and `stale` hide retired and archived rows; `retired` lists only those; `stale` is every live row needing a check. */
  state: z.enum(MEMORY_ENTRY_STATES).default('live'),
  /** Only the memories naming this record of the project: an issue or requirement key, or a workflow's flow. */
  cites: memoryCitesSchema.optional(),
  /** Only the memories naming no requirement, workflow or issue of the project: the project's own (REQ-33 BC-7). */
  uncited: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

type MemoryEntriesInput = z.infer<typeof memoryEntriesInputSchema>;

/** What `metadata` keeps of a person's act, before the actor is named. */
interface StoredAct {
  by: string | null;
  at: string;
  reason: string;
}

function storedAct(v: unknown): StoredAct | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'string' || typeof o.reason !== 'string') return null;
  return { by: typeof o.by === 'string' ? o.by : null, at: o.at, reason: o.reason };
}

function storedActs(v: unknown): StoredAct[] {
  return Array.isArray(v) ? v.map(storedAct).filter((a): a is StoredAct => a !== null) : [];
}

// A key the text may cite: rows naming one are read in full, since whether a cite is gone or
// changed is known only once it resolves.
const CITES_A_KEY = sql`${memories.textContent} ~ '\\m[A-Z][A-Z0-9]{1,5}-[0-9]{1,6}\\M'`;

const CHECK_AFTER_MS = MEMORY_CHECK_AFTER_DAYS * 86_400_000;

const columns = {
  id: memories.id,
  source: memories.source,
  sourceRef: memories.sourceRef,
  text: memories.textContent,
  metadata: memories.metadata,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
  lastVerifiedAt: memories.lastVerifiedAt,
  archivedAt: memories.archivedAt,
};

type Read = {
  id: string;
  source: string;
  sourceRef: string;
  text: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  lastVerifiedAt: Date | null;
  archivedAt: Date | null;
};

type Checked = { r: Read; c: Citations; needsCheck: MemoryCheckReason[]; changed: MemoryCite[] };

/** The cites of a memory that changed after it was last written or checked. */
function changedCites(r: Read, c: Citations): MemoryCite[] {
  const statedAt = Math.max(r.updatedAt.getTime(), r.lastVerifiedAt?.getTime() ?? 0);
  return c.cites.filter(
    (x) =>
      x.state === 'resolved' && x.changedAt !== undefined && Date.parse(x.changedAt) > statedAt,
  );
}

/**
 * Why a current memory needs a check (`MEMORY_CHECK_REASONS`, in order): nobody checked it for
 * `MEMORY_CHECK_AFTER_DAYS` days since it was written or last checked, a cited record changed after
 * the memory was last written or checked, a cited record no longer resolves, or a release flagged it.
 */
function checkReasons(r: Read, c: Citations, changed: readonly MemoryCite[], now: number) {
  const held = {
    unchecked: now - (r.lastVerifiedAt ?? r.createdAt).getTime() > CHECK_AFTER_MS,
    changed: changed.length > 0,
    gone: c.staleRefs.length > 0,
    flagged: typeof (r.metadata as Record<string, unknown> | null)?.staleSince === 'string',
  } satisfies Record<MemoryCheckReason, boolean>;
  return MEMORY_CHECK_REASONS.filter((k) => held[k]);
}

async function checked(
  projectId: string,
  read: Read[],
  now: number,
  reader: CiteReader,
): Promise<Checked[]> {
  const resolved = await resolveCitations(
    projectId,
    read.map((r) => r.text),
    reader,
  );
  return read.map((r, i) => {
    const c = resolved[i] ?? NO_CITATIONS;
    if (r.archivedAt) return { r, c, needsCheck: [], changed: [] };
    const changed = changedCites(r, c);
    return { r, c, needsCheck: checkReasons(r, c, changed, now), changed };
  });
}

async function countOf(where: SQL | undefined): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memories)
    .where(where);
  return Number(n);
}

export async function readMemoryEntries(
  input: MemoryEntriesInput,
  reader: CiteReader,
  now = Date.now(),
): Promise<{ rows: MemoryEntry[]; total: number; counts: Record<MemoryEntryState, number> }> {
  const scope: SQL[] = [
    eq(memories.projectId, input.projectId),
    inArray(memories.source, input.sources),
    ...(input.cites ? [namingWhere(input.cites)] : []),
  ];
  const live = and(...scope, isNull(memories.archivedAt), memoryOfLiveIssue(input.projectId));
  const retired = and(...scope, isNotNull(memories.archivedAt));
  const ordered = (where: SQL | undefined) =>
    db
      .select(columns)
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt), asc(memories.id));

  if (input.cites || input.uncited) {
    // which rows cite an item here is known only once each resolves: all are read, then counted
    // and cut by the same rule
    const [liveRows, retiredRows] = await Promise.all([
      ordered(live).then((r) => checked(input.projectId, r, now, reader)),
      ordered(retired).then((r) => checked(input.projectId, r, now, reader)),
    ]);
    const cites = input.cites;
    const keep = (rows: Checked[]) =>
      cites ? onlyCiting(input.projectId, cites, rows) : onlyUncited(input.projectId, rows);
    const lists = { live: await keep(liveRows), retired: await keep(retiredRows) };
    const due = lists.live.filter((x) => x.needsCheck.length > 0);
    const byState = { ...lists, stale: due };
    const counts = { live: lists.live.length, stale: due.length, retired: lists.retired.length };
    const page = byState[input.state].slice(input.offset, input.offset + input.limit);
    return { rows: await entriesOf(page), total: counts[input.state], counts };
  }

  // the rows that may need a check: unchecked past the cutoff, flagged, or citing a key; which of
  // them do is known once their cites resolve, so the list is cut after
  const cutoff = new Date(now - CHECK_AFTER_MS);
  const candidates = await ordered(
    and(
      live,
      sql`(coalesce(${memories.lastVerifiedAt}, ${memories.createdAt}) < ${cutoff.toISOString()}::timestamptz OR ${memories.metadata}->>'staleSince' IS NOT NULL OR ${CITES_A_KEY})`,
    ),
  );
  const due = (await checked(input.projectId, candidates, now, reader)).filter(
    (x) => x.needsCheck.length > 0,
  );
  const [liveN, retiredN] = await Promise.all([countOf(live), countOf(retired)]);
  const counts = { live: liveN, stale: due.length, retired: retiredN };

  let page: Checked[];
  if (input.state === 'stale') {
    page = due.slice(input.offset, input.offset + input.limit);
  } else {
    const read = await ordered(input.state === 'retired' ? retired : live)
      .limit(input.limit)
      .offset(input.offset);
    page = await checked(input.projectId, read, now, reader);
  }
  return { rows: await entriesOf(page), total: counts[input.state], counts };
}

interface StoredRevision {
  memoryId: string;
  text: string;
  writtenBy: string | null;
  replacedAt: Date;
  total: number;
}

/**
 * The bodies each of `ids` held before a later write or correction replaced it, newest first and at
 * most `MEMORY_REVISIONS_SHOWN` each, with how many there are in all: the rows the
 * `memories_record_replacement` trigger kept (migrations 0208, 0469).
 */
async function revisionsOf(ids: readonly string[]): Promise<Map<string, StoredRevision[]>> {
  const by = new Map<string, StoredRevision[]>();
  if (ids.length === 0) return by;
  const ranked = db
    .select({
      memoryId: memoryRevisions.memoryId,
      text: memoryRevisions.textContent,
      writtenBy: sql<string | null>`${memoryRevisions.metadata} ->> 'writtenBy'`.as('written_by'),
      replacedAt: memoryRevisions.replacedAt,
      rank: sql<number>`row_number() OVER (PARTITION BY ${memoryRevisions.memoryId} ORDER BY ${memoryRevisions.replacedAt} DESC, ${memoryRevisions.id})`.as(
        'rank',
      ),
      total: sql<number>`count(*) OVER (PARTITION BY ${memoryRevisions.memoryId})`.as('total'),
    })
    .from(memoryRevisions)
    .where(inArray(memoryRevisions.memoryId, [...ids]))
    .as('ranked');
  const rows = await db
    .select()
    .from(ranked)
    .where(lte(ranked.rank, MEMORY_REVISIONS_SHOWN))
    .orderBy(asc(ranked.memoryId), asc(ranked.rank));
  for (const r of rows) {
    const list = by.get(r.memoryId) ?? [];
    list.push({
      memoryId: r.memoryId,
      text: r.text,
      writtenBy: r.writtenBy,
      replacedAt: new Date(r.replacedAt),
      total: Number(r.total),
    });
    by.set(r.memoryId, list);
  }
  return by;
}

/** A page of read rows as the reader reads them: every writer, checker and actor named. */
async function entriesOf(page: Checked[]): Promise<MemoryEntry[]> {
  const md = (m: unknown) => (m ?? {}) as Record<string, unknown>;
  const revisions = await revisionsOf(page.map(({ r }) => r.id));
  const actorIds = page.flatMap(({ r }) => {
    const m = md(r.metadata);
    return [
      typeof m.verifiedBy === 'string' ? m.verifiedBy : null,
      typeof m.writtenBy === 'string' ? m.writtenBy : null,
      ...storedActs(m.corrections).map((a) => a.by),
      storedAct(m.retired)?.by ?? null,
      ...(revisions.get(r.id) ?? []).map((v) => v.writtenBy),
    ];
  });
  const people = await peopleOf(actorIds);
  const actor = (id: string | null): MemoryActor | null => {
    if (!id) return null;
    const p = people.get(id);
    return p ? { id, name: p.name, agent: p.kind === 'agent' } : { id, name: id, agent: false };
  };
  const act = (a: StoredAct): MemoryAct => ({ by: actor(a.by), at: a.at, reason: a.reason });

  const rows = page.map(({ r, c, needsCheck, changed }): MemoryEntry => {
    const m = md(r.metadata);
    const retired = storedAct(m.retired);
    return {
      id: r.id,
      source: r.source,
      sourceRef: r.sourceRef,
      text: r.text,
      writtenAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      writtenBy: actor(typeof m.writtenBy === 'string' ? m.writtenBy : null),
      verifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
      verifiedBy: r.lastVerifiedAt
        ? actor(typeof m.verifiedBy === 'string' ? m.verifiedBy : null)
        : null,
      cites: c.cites,
      staleRefs: c.staleRefs,
      needsCheck,
      changed,
      flagged:
        typeof m.staleSince === 'string'
          ? {
              since: m.staleSince,
              by: typeof m.supersededBy === 'string' ? m.supersededBy : null,
              // null only on a flag written by hand: 0458 dropped the reasonless ones and the reconcile makes none
              reason: typeof m.staleReason === 'string' ? m.staleReason : null,
            }
          : null,
      corrections: storedActs(m.corrections).map(act),
      revisions: (revisions.get(r.id) ?? []).map(
        (v): MemoryRevision => ({
          text: v.text,
          writtenBy: actor(v.writtenBy),
          replacedAt: v.replacedAt.toISOString(),
        }),
      ),
      revisionCount: revisions.get(r.id)?.[0]?.total ?? 0,
      retired: retired ? act(retired) : null,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      archivedBy: r.archivedAt && !retired ? archivedByOf(m) : null,
    };
  });
  return rows;
}

/**
 * Why a row no person retired is archived, as facts: decay writes one of its two rule constants
 * (`decay.ts`), read back by equality and never parsed; an agent's outdated verdict keeps its
 * evidence on `metadata.feedback`.
 */
function archivedByOf(m: Record<string, unknown>): MemoryArchiveCause | null {
  if (m.archivedBy === DECAY_UNUSED) return { rule: 'unused' };
  if (typeof m.archivedBy === 'string' && m.archivedBy.startsWith(DECAY_FLAGGED)) {
    return { rule: 'flagged', by: typeof m.supersededBy === 'string' ? m.supersededBy : null };
  }
  if (typeof m.archivedBy === 'string') return { rule: 'recorded', text: m.archivedBy };
  const feedback = Array.isArray(m.feedback) ? m.feedback : [];
  const last = feedback[feedback.length - 1] as Record<string, unknown> | undefined;
  if (last && last.verdict === 'outdated' && typeof last.evidence === 'string') {
    return { rule: 'outdated', evidence: last.evidence };
  }
  return null;
}
