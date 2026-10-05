// Pointwise rerank of a fused hybrid candidate set by the system-job fast model. Each candidate is
// graded on its own against the query, as a typed answer the AI SDK parses through a zod schema, so
// one unreadable answer costs that candidate's grade and never the reading of a whole list. The
// hits are ordered by grade only when every candidate was graded; otherwise they keep the fused
// (RRF) order and the result says so as a degraded rerank, with the reason and how many went
// ungraded. Either way the result names the path that ordered it and the model version that graded.
// This module never throws.

import { createHash, randomInt } from 'node:crypto';
import {
  RERANK_GRADES,
  type RerankDegradedReason,
  type RerankGrade,
  type RerankReport,
} from '@forge/contracts/memory';
import { z } from 'zod';
import {
  callFastModelObject,
  type FastModelMiss,
  fastModelName,
} from '../integrations/llm/index.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import type { MemoryHit } from './search.js';

const RERANK_POOL_FACTOR = 3;
const RERANK_POOL_CAP = 50;
const RERANK_HOLDOUT_ONE_IN = 5;
const CANDIDATE_CHARS = 1500;
const GRADE_MAX_TOKENS = 64;
const CONCURRENT_GRADES = 8;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 2000;

const gradeAnswer = z.strictObject({ relevance: z.enum(RERANK_GRADES) });

interface RerankInput {
  query: string;
  hits: MemoryHit[];
  topK: number;
}

interface RerankResult {
  hits: MemoryHit[];
  report: RerankReport;
  rerankMs: number;
}

/** The model the rerank call names: `RERANK_MODEL` when set, else the fast model every other system job uses. */
export function rerankModel(): string {
  return env.RERANK_MODEL ?? fastModelName();
}

/** How many fused candidates to grade so the model can lift a hit RRF left just outside `topK`. */
export function rerankPoolSize(topK: number): number {
  return Math.min(topK * RERANK_POOL_FACTOR, RERANK_POOL_CAP);
}

export function inRerankHoldout(): boolean {
  return randomInt(RERANK_HOLDOUT_ONE_IN) === 0;
}

function buildGradePrompt(query: string, text: string): string {
  return [
    'Grade how well the passage answers the query.',
    `Answer with ONLY a JSON object of the form {"relevance": "<grade>"}, where <grade> is one of ${RERANK_GRADES.map((g) => `"${g}"`).join(', ')}: "none" when the passage has nothing to do with the query, "strong" when it answers it directly.`,
    `Query: ${query}`,
    `Passage:\n${text.slice(0, CANDIDATE_CHARS)}`,
  ].join('\n\n');
}

/** Candidates by grade, strongest first; equal grades keep their fused (RRF) order. */
function orderByGrade<T>(candidates: T[], grades: RerankGrade[]): T[] {
  const rank = (g: RerankGrade) => RERANK_GRADES.indexOf(g);
  return candidates
    .map((c, i) => ({ c, i, r: rank(grades[i] as RerankGrade) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.c);
}

function gradeCacheKey(model: string, query: string, hit: MemoryHit): string {
  return createHash('sha256')
    .update(model)
    .update('|')
    .update(query)
    .update('|')
    .update(hit.id)
    .update(':')
    .update(hit.text)
    .digest('hex');
}

type Graded = { grade: RerankGrade; modelId: string };
const cache = new Map<string, Graded & { at: number }>();

function cacheGet(key: string, now: number): Graded | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, graded: Graded, now: number): void {
  cache.set(key, { ...graded, at: now });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function resetRerankCache(): void {
  cache.clear();
}

const limiter = createLimiter(CONCURRENT_GRADES);

async function gradeOne(
  model: string,
  query: string,
  hit: MemoryHit,
): Promise<Graded | { miss: FastModelMiss; detail: string }> {
  const key = gradeCacheKey(model, query, hit);
  const cached = cacheGet(key, Date.now());
  if (cached) return cached;
  const answer = await limiter.run(() =>
    callFastModelObject({ surface: 'memory' }, buildGradePrompt(query, hit.text), gradeAnswer, {
      maxTokens: GRADE_MAX_TOKENS,
      model,
    }),
  );
  if (!answer.ok) return { miss: answer.miss, detail: answer.detail };
  const graded = { grade: answer.value.relevance, modelId: answer.modelId };
  cacheSet(key, graded, Date.now());
  return graded;
}

/** The commonest miss names the degradation; a tie goes to the first one met. */
function dominantMiss(misses: FastModelMiss[]): RerankDegradedReason {
  const counts = new Map<FastModelMiss, number>();
  for (const m of misses) counts.set(m, (counts.get(m) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as RerankDegradedReason;
}

/** Grade `hits` and cut to `topK`; when any candidate went ungraded the RRF order is cut instead and reported as degraded. */
export async function rerankHits(input: RerankInput): Promise<RerankResult> {
  const startedAt = Date.now();
  const model = rerankModel();
  if (input.hits.length <= 1) {
    return {
      hits: input.hits.slice(0, input.topK),
      report: { path: 'rrf' },
      rerankMs: Date.now() - startedAt,
    };
  }
  const outcomes = await Promise.all(input.hits.map((hit) => gradeOne(model, input.query, hit)));
  const rerankMs = Date.now() - startedAt;
  const grades: RerankGrade[] = [];
  const misses: FastModelMiss[] = [];
  let modelId = model;
  for (const o of outcomes) {
    if ('miss' in o) misses.push(o.miss);
    else {
      grades.push(o.grade);
      modelId = o.modelId;
    }
  }
  if (misses.length > 0) {
    const reason = dominantMiss(misses);
    const first = outcomes.find((o): o is { miss: FastModelMiss; detail: string } => 'miss' in o);
    logger.warn(
      {
        model,
        reason,
        unscored: misses.length,
        candidates: input.hits.length,
        detail: first?.detail,
      },
      'memory.rerank: degraded to the fused order, a candidate went ungraded',
    );
    return {
      hits: input.hits.slice(0, input.topK),
      report: {
        path: 'rrf',
        model: modelId,
        degraded: { reason, unscored: misses.length, candidates: input.hits.length },
      },
      rerankMs,
    };
  }
  const hits = orderByGrade(input.hits, grades)
    .slice(0, input.topK)
    .map((hit, i) => ({ ...hit, rerankPosition: i }));
  return { hits, report: { path: 'model', model: modelId }, rerankMs };
}
