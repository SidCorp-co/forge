/**
 * Keeps `issue_alike_seeds` and `issue_alike_hits` current (ISS-1336): for each unsettled issue,
 * the vector of its title and the issues the memory search finds nearest to it.
 *
 * A seed is measured by the retrieval function the ISS-1173 sweep calls, with its source filter,
 * memory model and stale demotion, so a hit's score is the sweep's score. What moved is when: a
 * seed is searched when its own title changes, and when a changed issue memory could change its
 * answer, not on every sweep.
 *
 * A changed target can change a seed's nearest set only if it is in that set now, or scores
 * above the lowest score the set kept. The first is a lookup and the second a cosine against the
 * stored title vector, so the seeds to search again are found without a search. A seed that holds
 * fewer than the full set has no lowest score and is always searched again.
 */

import { sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { encodeVectorLiteral } from '../../db/pgvector.js';
import { EmbeddingUnavailableError, embedBatch } from '../../embeddings/index.js';
import { loadRetrievalFlags, RETRIEVAL_FLAGS_OFF } from '../../memory/retrieval-flags.js';
import { searchMemories } from '../../memory/search.js';
import { EMBED_BATCH_SIZE, SEED_QUERY_MAX } from './alike-source.js';
import {
  claimMarks,
  isWholeProject,
  markSubjects,
  releaseMarks,
  tryDrainLock,
} from './index-dirty.js';
import {
  type IndexExecutor,
  rowsOf,
  textList,
  UNSETTLED_STATUSES,
  uuidArray,
} from './index-sql.js';

/** How many neighbours a seed keeps, which is the CLI's own `TOP_K`. A read may ask for fewer. */
export const ALIKE_TOP_K = 10;

/** Marks one drain takes; a project with more drains over several passes. */
export const ALIKE_DRAIN_BATCH = 100;

/** Seeds one pass embeds and searches. A whole-project mark names every issue, so the pass takes this many and re-marks the rest: a call that spends a budget on catching up never waits on thousands of provider calls. */
export const ALIKE_SEEDS_PER_PASS = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AlikeDrainResult {
  outcome: 'drained' | 'idle' | 'busy' | 'refused';
  claimed: number;
  /** The seeds whose nearest set was searched for and stored. */
  measured: string[];
  /** The seeds whose title was embedded, which is a call to the provider. */
  embedded: string[];
  /** The seeds deleted because the issue is no longer unsettled. */
  removed: string[];
  refusal?: string;
}

/** What a stored measurement is only valid under: the memory model it searched and the model that embedded the title. */
export async function currentMeasuredWith(
  projectId: string,
  executor: IndexExecutor = db,
): Promise<string> {
  const [row] = await rowsOf(
    executor,
    sql`SELECT memory_model FROM app_config WHERE project_id = ${projectId}::uuid LIMIT 1`,
  );
  const model = row?.memory_model ? String(row.memory_model) : RETRIEVAL_FLAGS_OFF.memoryModel;
  return `${model}|${env.EMBEDDINGS_MODEL}`;
}

/**
 * The seeds a changed issue memory can move: the ones that list it, and the ones whose title
 * vector scores it above their lowest kept score, by its flat embedding or any of its chunks (a
 * superset of what a search over either arm would reach).
 */
export async function seedsAffectedBy(
  executor: IndexExecutor,
  projectId: string,
  targetId: string,
): Promise<string[]> {
  const rows = await rowsOf(
    executor,
    sql`
    SELECT h.seed_issue_id::text AS id FROM issue_alike_hits h
      JOIN issue_alike_seeds s ON s.issue_id = h.seed_issue_id
     WHERE s.project_id = ${projectId}::uuid AND h.hit_issue_id = ${targetId}::uuid
    UNION
    SELECT s.issue_id::text
      FROM issue_alike_seeds s
     WHERE s.project_id = ${projectId}::uuid
       AND (
         s.floor_score IS NULL
         OR EXISTS (
           SELECT 1 FROM memories m
            WHERE m.project_id = s.project_id AND m.source = 'issue' AND m.source_ref = ${targetId}
              AND m.embedding IS NOT NULL
              AND 1 - (m.embedding <=> s.title_embedding) >= s.floor_score - 0.0001)
         OR EXISTS (
           SELECT 1 FROM memories m JOIN memory_chunks c ON c.memory_id = m.id
            WHERE m.project_id = s.project_id AND m.source = 'issue' AND m.source_ref = ${targetId}
              AND c.embedding IS NOT NULL
              AND 1 - (c.embedding <=> s.title_embedding) >= s.floor_score - 0.0001))`,
  );
  return rows.map((row) => String(row.id));
}

interface SeedIssue {
  id: string;
  title: string;
}

async function unsettledIssues(
  executor: IndexExecutor,
  projectId: string,
  ids: readonly string[] | null,
): Promise<SeedIssue[]> {
  const scope = ids === null ? sql`` : sql`AND i.id = ANY(${uuidArray(ids)})`;
  const rows = await rowsOf(
    executor,
    sql`SELECT i.id::text AS id, i.title FROM issues i
         WHERE i.project_id = ${projectId}::uuid AND i.archived_at IS NULL
           AND i.status IN (${textList(UNSETTLED_STATUSES)}) ${scope}`,
  );
  return rows.map((row) => ({ id: String(row.id), title: String(row.title) }));
}

const queryOf = (title: string) => title.slice(0, SEED_QUERY_MAX);

function shortBatch(wanted: number, got: number): Error {
  return Object.assign(
    new Error(
      `embeddings returned ${got} vector(s) for ${wanted} title(s); refusing rather than storing a ` +
        'neighbour set for a title that has none and reporting the index complete',
    ),
    { code: 'EMBEDDING_COUNT_MISMATCH' },
  );
}

function parseVector(text: string): number[] {
  return JSON.parse(text) as number[];
}

/** The nearest issues for one vector, in the order the sweep serves them: fresh rows, then stale. */
async function nearest(projectId: string, queryVec: number[], memoryModel: 'flat' | 'chunked') {
  const hits = await searchMemories({
    projectId,
    topK: ALIKE_TOP_K,
    sourceFilter: ['issue'],
    queryVec,
    memoryModel,
  });
  return [...hits.filter((h) => !h.stale), ...hits.filter((h) => h.stale)];
}

async function storeSeed(
  executor: IndexExecutor,
  projectId: string,
  seed: SeedIssue,
  vector: number[],
  measuredWith: string,
  hits: Awaited<ReturnType<typeof nearest>>,
): Promise<void> {
  const floor = hits.length >= ALIKE_TOP_K ? Math.min(...hits.map((h) => h.score)) : null;
  await executor.execute(sql`
    INSERT INTO issue_alike_seeds
      (issue_id, project_id, title, title_embedding, measured_with, floor_score, measured_at)
    VALUES (${seed.id}::uuid, ${projectId}::uuid, ${seed.title},
            ${encodeVectorLiteral(vector)}::vector, ${measuredWith}, ${floor}::real, now())
    ON CONFLICT (issue_id) DO UPDATE SET
      title = EXCLUDED.title, title_embedding = EXCLUDED.title_embedding,
      measured_with = EXCLUDED.measured_with, floor_score = EXCLUDED.floor_score,
      measured_at = EXCLUDED.measured_at`);
  await executor.execute(sql`DELETE FROM issue_alike_hits WHERE seed_issue_id = ${seed.id}::uuid`);
  if (hits.length === 0) return;
  await executor.execute(sql`
    INSERT INTO issue_alike_hits (seed_issue_id, position, memory_id, hit_issue_id, score, stale)
    VALUES ${sql.join(
      hits.map(
        (hit, position) =>
          sql`(${seed.id}::uuid, ${position}::int, ${hit.id}::uuid,
               ${UUID_RE.test(hit.sourceRef) ? hit.sourceRef : null}::uuid,
               ${hit.score}::real, ${hit.stale}::boolean)`,
      ),
      sql`, `,
    )}`);
}

/** One pass: the lock makes it the only drain of this project, as for the ranking. */
export async function drainAlike(
  projectId: string,
  options: { batch?: number; deadline?: number } = {},
): Promise<AlikeDrainResult> {
  return db.transaction(async (tx): Promise<AlikeDrainResult> => {
    const none = { claimed: 0, measured: [], embedded: [], removed: [] };
    if (!(await tryDrainLock(tx, 'alike', projectId))) return { outcome: 'busy', ...none };
    const marks = await claimMarks(
      tx,
      projectId,
      ['alike-seed', 'alike-target'],
      options.batch ?? ALIKE_DRAIN_BATCH,
    );
    if (marks.length === 0) return { outcome: 'idle', ...none };

    const flags = await loadRetrievalFlags(projectId);
    const measuredWith = `${flags.memoryModel}|${env.EMBEDDINGS_MODEL}`;

    const wholeSeeds = marks.some((m) => m.kind === 'alike-seed' && isWholeProject(m));
    const named = new Set<string>();
    for (const mark of marks) {
      if (mark.kind === 'alike-seed' && !isWholeProject(mark)) named.add(mark.subjectId);
      if (mark.kind === 'alike-target') {
        for (const id of await seedsAffectedBy(tx, projectId, mark.subjectId)) named.add(id);
        // The target is a seed too, when it is unsettled: its own title is searched by its own mark.
      }
    }

    const everyWanted = await unsettledIssues(tx, projectId, wholeSeeds ? null : [...named]);
    const wantedIds = new Set(everyWanted.map((one) => one.id));
    const wanted = everyWanted.slice(0, ALIKE_SEEDS_PER_PASS);
    await markSubjects(
      tx,
      'alike-seed',
      projectId,
      everyWanted.slice(ALIKE_SEEDS_PER_PASS).map((one) => one.id),
      'left for the next pass',
    );
    const gone = wholeSeeds
      ? (
          await rowsOf(
            tx,
            sql`SELECT issue_id::text AS id FROM issue_alike_seeds WHERE project_id = ${projectId}::uuid`,
          )
        )
          .map((row) => String(row.id))
          .filter((id) => !wantedIds.has(id))
      : [...named].filter((id) => !wantedIds.has(id));
    const removed = gone.length
      ? (
          await rowsOf(
            tx,
            sql`DELETE FROM issue_alike_seeds WHERE project_id = ${projectId}::uuid
                   AND issue_id = ANY(${uuidArray(gone)}) RETURNING issue_id::text AS id`,
          )
        ).map((row) => String(row.id))
      : [];

    // A title is embedded once, when it is new or has changed; an unchanged one keeps its vector.
    const stored = new Map<string, { title: string; vector: string; measuredWith: string }>();
    if (wanted.length > 0) {
      const rows = await rowsOf(
        tx,
        sql`SELECT issue_id::text AS id, title, title_embedding::text AS vector, measured_with
              FROM issue_alike_seeds WHERE issue_id = ANY(${uuidArray(wanted.map((s) => s.id))})`,
      );
      for (const row of rows) {
        stored.set(String(row.id), {
          title: String(row.title),
          vector: String(row.vector),
          measuredWith: String(row.measured_with),
        });
      }
    }
    const model = env.EMBEDDINGS_MODEL;
    const needsVector = wanted.filter((seed) => {
      const held = stored.get(seed.id);
      return !held || held.title !== seed.title || !held.measuredWith.endsWith(`|${model}`);
    });
    const fresh = new Map<string, number[]>();
    const pastDeadline = () => options.deadline !== undefined && Date.now() >= options.deadline;
    try {
      for (let at = 0; at < needsVector.length && !pastDeadline(); at += EMBED_BATCH_SIZE) {
        const chunk = needsVector.slice(at, at + EMBED_BATCH_SIZE);
        const vectors = await embedBatch(chunk.map((seed) => queryOf(seed.title)));
        if (vectors.length !== chunk.length) throw shortBatch(chunk.length, vectors.length);
        for (const [i, seed] of chunk.entries()) fresh.set(seed.id, vectors[i] as number[]);
      }
    } catch (error) {
      if (!(error instanceof EmbeddingUnavailableError)) throw error;
      return {
        outcome: 'refused',
        ...none,
        claimed: marks.length,
        refusal: `the embeddings provider is unavailable, so no title was embedded: ${error.message}`,
      };
    }

    const measured: string[] = [];
    const unreached: string[] = [];
    for (const seed of wanted) {
      const held = stored.get(seed.id);
      const wasEmbedded = !needsVector.includes(seed) || fresh.has(seed.id);
      if (!wasEmbedded || (pastDeadline() && measured.length > 0)) {
        unreached.push(seed.id);
        continue;
      }
      const vector = fresh.get(seed.id) ?? parseVector(held?.vector ?? '[]');
      const hits = await nearest(projectId, vector, flags.memoryModel);
      await storeSeed(tx, projectId, seed, vector, measuredWith, hits);
      measured.push(seed.id);
    }

    await markSubjects(tx, 'alike-seed', projectId, unreached, 'left for the next pass');
    await releaseMarks(tx, projectId, marks);
    return {
      outcome: 'drained',
      claimed: marks.length,
      measured,
      embedded: [...fresh.keys()],
      removed,
    };
  });
}
