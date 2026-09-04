// One-hop relation expansion (retrieval v3 phase 3, ISS-905): the issues a
// ranked issue hit blocks, is blocked by, or relates to, appended after the
// ranking as context. The ranking is the retriever's claim; these rows are a
// courtesy, so they carry `score: 0` and a `via` saying which hit they hang off.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, memories } from '../db/schema.js';
import { loadIssueRelations } from '../issues/dependency-read.js';
import { deriveMemoryStaleness, type MemoryHit, type MemoryVia } from './search.js';

export const EXPAND_SEED_LIMIT = 5;
export const EXPAND_RELATION_KINDS: ReadonlyArray<MemoryVia['relation']> = ['blocks', 'relates'];

export interface ExpandRelationsInput {
  projectId: string;
  hits: MemoryHit[];
  topK: number;
}

type Neighbour = { issueId: string; via: MemoryVia };

function isExpandable(kind: string): kind is MemoryVia['relation'] {
  return (EXPAND_RELATION_KINDS as ReadonlyArray<string>).includes(kind);
}

async function displayIds(issueIds: string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({ id: issues.id, issSeq: issues.issSeq })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  return new Map(rows.map((r) => [r.id, `ISS-${r.issSeq}`]));
}

// cm:guard both directions are walked (`blocks` and `blockedBy`) and expired edges are dropped — the blocked issue is as relevant to a reader as its blocker, and an edge past `validUntil` was retracted on purpose (forge_issues.update with validUntil in the past is the documented retraction), so surfacing it would resurrect a relation someone removed
async function neighboursOf(
  seed: MemoryHit,
  projectId: string,
  from: string,
): Promise<Neighbour[]> {
  const { blocks, blockedBy } = await loadIssueRelations(seed.sourceRef, projectId);
  return [...blocks, ...blockedBy]
    .filter((edge) => !edge.expired && isExpandable(edge.kind))
    .map((edge) => ({
      issueId: edge.otherIssueId,
      via: { relation: edge.kind as MemoryVia['relation'], from },
    }));
}

// cm:guard the cap is applied AFTER hydration, never here — a neighbour with no memory row (never indexed, archived, degraded) must not consume one of the `topK` slots, or edge order alone decides whether a real neighbour is ever queried (codex review of ISS-905, 2026-09-04)
function pickNeighbours(perSeed: Neighbour[][], present: Set<string>): Neighbour[] {
  const chosen: Neighbour[] = [];
  for (const list of perSeed) {
    for (const n of list) {
      if (present.has(n.issueId)) continue;
      present.add(n.issueId);
      chosen.push(n);
    }
  }
  return chosen;
}

/** The rows to append after `hits`: never interleaved, at most `topK`, none already in `hits`. */
export async function expandIssueRelations(input: ExpandRelationsInput): Promise<MemoryHit[]> {
  const seeds = input.hits.filter((h) => h.source === 'issue').slice(0, EXPAND_SEED_LIMIT);
  if (seeds.length === 0 || input.topK <= 0) return [];

  const labels = await displayIds(seeds.map((s) => s.sourceRef));
  const perSeed = await Promise.all(
    seeds.map((seed) =>
      neighboursOf(seed, input.projectId, labels.get(seed.sourceRef) ?? seed.sourceRef),
    ),
  );
  const present = new Set(input.hits.filter((h) => h.source === 'issue').map((h) => h.sourceRef));
  const chosen = pickNeighbours(perSeed, present);
  if (chosen.length === 0) return [];

  const rows = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      text: memories.textContent,
      metadata: memories.metadata,
      embeddedAt: memories.embeddedAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, 'issue'),
        inArray(
          memories.sourceRef,
          chosen.map((n) => n.issueId),
        ),
        isNull(memories.archivedAt),
      ),
    );
  const bySourceRef = new Map(rows.map((r) => [r.sourceRef, r]));

  const appended: MemoryHit[] = [];
  for (const n of chosen) {
    if (appended.length >= input.topK) break;
    const row = bySourceRef.get(n.issueId);
    if (!row) continue;
    appended.push({
      id: row.id,
      source: 'issue',
      sourceRef: row.sourceRef,
      text: row.text,
      metadata: row.metadata,
      score: 0,
      embeddedAt: row.embeddedAt,
      ...deriveMemoryStaleness(row.metadata),
      via: n.via,
    });
  }
  return appended;
}
