// MJ-1: the project's memory as a person reads it — what it says, who wrote it and when, whether
// anyone checked it, which records it names and which of those no longer resolve, why it needs a
// check, and every correction or retirement a person made with their reason; with each list's
// count, read by the same rule. Behind `GET /api/memory/entries`.
//
// Does NOT check authorization — callers MUST verify project membership before invoking.

import {
  MEMORY_AUTHORED_SOURCES,
  MEMORY_CHECK_AFTER_DAYS,
  MEMORY_CHECK_REASONS,
  MEMORY_ENTRY_STATES,
  type MemoryAct,
  type MemoryActor,
  type MemoryArchiveCause,
  type MemoryCheckReason,
  type MemoryCite,
  type MemoryEntry,
  type MemoryEntryState,
} from '@forge/contracts/memory';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { peopleOf } from '../lib/people.js';
import { DECAY_FLAGGED, DECAY_UNUSED } from './decay.js';
import { memoryOfLiveIssue } from './live-issue.js';
import { type Citations, resolveCitations } from './stale-refs.js';

const NO_CITATIONS: Citations = { cites: [], staleRefs: [] };

export const memoryEntriesInputSchema = z.object({
  projectId: z.uuid(),
  /** Words to find in the text or the ref, any order; empty lists everything. */
  q: z.string().trim().max(200).optional(),
  sources: z
    .array(z.enum(memorySources))
    .min(1)
    .default([...MEMORY_AUTHORED_SOURCES]),
  /** `live` and `stale` hide retired and archived rows; `retired` lists only those; `stale` is every live row needing a check. */
  state: z.enum(MEMORY_ENTRY_STATES).default('live'),
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

function likeWords(q: string | undefined): SQL[] {
  if (!q) return [];
  return q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((w) => {
      const pat = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return sql`(${memories.textContent} ILIKE ${pat} OR ${memories.sourceRef} ILIKE ${pat})`;
    });
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

async function checked(projectId: string, read: Read[], now: number): Promise<Checked[]> {
  const resolved = await resolveCitations(
    projectId,
    read.map((r) => r.text),
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
  now = Date.now(),
): Promise<{ rows: MemoryEntry[]; total: number; counts: Record<MemoryEntryState, number> }> {
  const scope: SQL[] = [
    eq(memories.projectId, input.projectId),
    inArray(memories.source, input.sources),
    ...likeWords(input.q),
  ];
  const live = and(...scope, isNull(memories.archivedAt), memoryOfLiveIssue(input.projectId));
  const retired = and(...scope, isNotNull(memories.archivedAt));
  const ordered = (where: SQL | undefined) =>
    db
      .select(columns)
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt), asc(memories.id));

  // the rows that may need a check: unchecked past the cutoff, flagged, or citing a key; which of
  // them do is known once their cites resolve, so the list is cut after
  const cutoff = new Date(now - CHECK_AFTER_MS);
  const candidates = await ordered(
    and(
      live,
      sql`(coalesce(${memories.lastVerifiedAt}, ${memories.createdAt}) < ${cutoff.toISOString()}::timestamptz OR ${memories.metadata}->>'staleSince' IS NOT NULL OR ${CITES_A_KEY})`,
    ),
  );
  const due = (await checked(input.projectId, candidates, now)).filter(
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
    page = await checked(input.projectId, read, now);
  }
  const total = counts[input.state];

  const md = (m: unknown) => (m ?? {}) as Record<string, unknown>;
  const actorIds = page.flatMap(({ r }) => {
    const m = md(r.metadata);
    return [
      typeof m.verifiedBy === 'string' ? m.verifiedBy : null,
      typeof m.writtenBy === 'string' ? m.writtenBy : null,
      ...storedActs(m.corrections).map((a) => a.by),
      storedAct(m.retired)?.by ?? null,
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
      retired: retired ? act(retired) : null,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      archivedBy: r.archivedAt && !retired ? archivedByOf(m) : null,
    };
  });
  return { rows, total, counts };
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
