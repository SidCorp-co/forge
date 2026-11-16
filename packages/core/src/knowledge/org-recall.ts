// REQ-89 BC-7 (ISS-1121): an org's rules are recalled by search, not only by their exact slug. Before
// this, an on-demand org entry (every `-full` guide) was reachable only by name and an always-on one
// only in the prompt: `knowledge/search` and MCP `search` read the project's own store alone. The org
// arms here rank the entries of the orgs a reader's projects belong to beside the project's own, each
// labelled `origin: 'org'`, and leave out one a project entry under the same slug takes the place of.
//
// An org entry is embedded on first recall and kept for the process under its id and last write, so a
// rewrite is embedded again and an org of a few dozen rulings costs one batch per process. An
// embeddings outage leaves the keyword arm, which reads each word of the query on its own (any word,
// `any-word.ts`), under the one rule a project entry is matched by (ISS-1142): the same `english`
// configuration, so a stop word ("the", "when") matches no ruling, as it matches no project entry.

import type { CuratedEntryType, RecheckDue } from '@forge/contracts/knowledge';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, orgKnowledgeEntries, projects } from '../db/schema.js';
import { EmbeddingUnavailableError, embedBatch } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { anyWordQuery } from './any-word.js';
import { knowledgeEmbedInput } from './entry-input.js';
import { recheckDueOf } from './recheck.js';

/** An org entry as recall answers it, shaped as a project hit so the two rank in one list. */
export interface OrgRecallHit {
  id: string;
  origin: 'org';
  orgId: string;
  slug: string;
  kind: 'rule';
  title: string;
  body: string;
  injection: string;
  confidence: 'verified';
  type: CuratedEntryType;
  source: string | null;
  scope: string | null;
  recheckWhen: string | null;
  recheckDue: RecheckDue | null;
  score: number;
}

type Row = typeof orgKnowledgeEntries.$inferSelect;

/** The org entries the projects reach, less those a project entry under the same slug replaces. */
async function reachable(projectIds: readonly string[]): Promise<Row[]> {
  if (projectIds.length === 0) return [];
  const shadowed = db
    .select({ slug: knowledgeEntries.slug })
    .from(knowledgeEntries)
    .where(inArray(knowledgeEntries.projectId, [...projectIds]));
  const rows = await db
    .selectDistinct({ entry: orgKnowledgeEntries })
    .from(orgKnowledgeEntries)
    .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
    .where(
      and(inArray(projects.id, [...projectIds]), notInArray(orgKnowledgeEntries.slug, shadowed)),
    );
  return rows.map((r) => r.entry);
}

const hitOf = (r: Row, score: number): OrgRecallHit => ({
  id: r.id,
  origin: 'org',
  orgId: r.orgId,
  slug: r.slug,
  kind: 'rule',
  title: r.title,
  body: r.body,
  injection: r.injection,
  confidence: 'verified',
  // an org entry is a ruling its owner set: a convention, by what it is
  type: 'convention',
  source: r.source,
  scope: r.scope,
  recheckWhen: r.recheckWhen,
  recheckDue: recheckDueOf(r.recheckDue),
  score,
});

const vectors = new Map<string, { at: number; vector: number[] }>();

/** Each entry's vector, embedding those not yet held at their last write; null in an outage. */
async function vectorsOf(rows: Row[]): Promise<Map<string, number[]> | null> {
  const stale = rows.filter((r) => vectors.get(r.id)?.at !== r.updatedAt.getTime());
  if (stale.length > 0) {
    try {
      const embedded = await embedBatch(
        { surface: 'knowledge' },
        stale.map((r) => knowledgeEmbedInput(r.title, r.body)),
      );
      stale.forEach((r, i) => {
        const vector = embedded[i];
        if (vector) vectors.set(r.id, { at: r.updatedAt.getTime(), vector });
      });
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
      logger.warn({ entries: stale.length }, 'knowledge.org-recall: embeddings unavailable');
      return null;
    }
  }
  return new Map(
    rows.flatMap((r) => (vectors.has(r.id) ? [[r.id, vectors.get(r.id)?.vector ?? []]] : [])),
  );
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The org entries the projects reach, by cosine to the query; null where they could not be embedded. */
export async function semanticOrgRecall(
  projectIds: readonly string[],
  queryVec: number[],
  topK: number,
): Promise<OrgRecallHit[] | null> {
  const rows = await reachable(projectIds);
  if (rows.length === 0) return [];
  const held = await vectorsOf(rows);
  if (!held) return null;
  return rows
    .flatMap((r) => {
      const v = held.get(r.id);
      return v ? [hitOf(r, cosine(queryVec, v))] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * The org entries the projects reach whose slug, title or body holds a word of the query, ranked by
 * how much of it they hold; an entry whose slug the query names outright ranks first.
 */
export async function keywordOrgRecall(
  projectIds: readonly string[],
  query: string,
  topK: number,
): Promise<OrgRecallHit[]> {
  const words = anyWordQuery(query);
  if (!words || projectIds.length === 0) return [];
  const ids = (await reachable(projectIds)).map((r) => r.id);
  if (ids.length === 0) return [];
  const doc = sql`to_tsvector('english', ${orgKnowledgeEntries.slug} || ' ' || replace(${orgKnowledgeEntries.slug}, '-', ' ') || ' ' || ${orgKnowledgeEntries.title} || ' ' || ${orgKnowledgeEntries.body})`;
  const tsq = sql`to_tsquery('english', ${words})`;
  const named = sql`(position(${orgKnowledgeEntries.slug} in ${query.toLowerCase()}) > 0 OR position(replace(${orgKnowledgeEntries.slug}, '-', ' ') in ${query.toLowerCase()}) > 0)`;
  const rows = await db
    .select({
      entry: orgKnowledgeEntries,
      rank: sql<number>`ts_rank(${doc}, ${tsq}) + CASE WHEN ${named} THEN 1 ELSE 0 END`.as('rank'),
    })
    .from(orgKnowledgeEntries)
    .where(and(inArray(orgKnowledgeEntries.id, ids), sql`(${doc} @@ ${tsq} OR ${named})`))
    .orderBy(sql`rank DESC`)
    .limit(topK);
  return rows.map((r) => hitOf(r.entry, Number(r.rank)));
}
