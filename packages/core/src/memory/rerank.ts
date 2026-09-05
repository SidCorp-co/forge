// Listwise rerank of a fused hybrid candidate set by the system-job fast model
// (retrieval v3 phase 1, ISS-905). One chat completion orders every candidate;
// `topK` is applied here, after the model answered. Anything the model gets
// wrong — prose, an index out of range, a duplicate, a transport failure —
// leaves the RRF order untouched and is reported as `reranked: false`; this
// module never throws.

import { createHash, randomInt } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { callFastModel, fastModelName } from './llm.js';
import type { MemoryHit } from './search.js';

export const RERANK_POOL_FACTOR = 3;
export const RERANK_POOL_CAP = 50;
export const RERANK_HOLDOUT_ONE_IN = 5;
const CANDIDATE_CHARS = 600;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;

export interface RerankInput {
  query: string;
  hits: MemoryHit[];
  topK: number;
}

export interface RerankResult {
  hits: MemoryHit[];
  reranked: boolean;
  rerankMs: number;
}

/** The model the rerank call names: `RERANK_MODEL` when set, else the fast model every other system job uses. */
export function rerankModel(): string {
  return env.RERANK_MODEL ?? fastModelName();
}

/** How many fused candidates to rank so the model can lift a hit RRF left just outside `topK`. */
export function rerankPoolSize(topK: number): number {
  return Math.min(topK * RERANK_POOL_FACTOR, RERANK_POOL_CAP);
}

// cm:guard the holdout is drawn per search and only for calls that would otherwise be reranked — the pilot's exit criterion (docs/proposals/retrieval-v3-rerank-chunks.md, phase 1) compares confirmed-feedback rates of `reranked:true` rows against `rerankHoldout:true` rows, so a holdout drawn on ineligible calls or skipped on eligible ones leaves the flag with no control group
export function inRerankHoldout(): boolean {
  return randomInt(RERANK_HOLDOUT_ONE_IN) === 0;
}

// cm:guard the model is shown the text that MATCHED — the passage on a chunked project, the whole row otherwise — and the cache key hashes the same string; showing the row head on a chunked project demoted the exact-passage hit out of the top 8 in 2 of 4 live passes on forge-dev and 1→4 / 1→5 on forge-plugin (2026-09-05, ISS-913), because a 75k-character issue was judged by its first paragraph while the query matched passage 76
export function shownText(hit: MemoryHit): string {
  return hit.matchedChunk?.text ?? hit.text;
}

export function buildRerankPrompt(query: string, texts: string[]): string {
  const blocks = texts.map((t, i) => `[${i + 1}]\n${t.slice(0, CANDIDATE_CHARS)}`).join('\n\n');
  return [
    'Rank the numbered passages by how well each answers the query. Reply with ONLY a JSON array of passage numbers, most relevant first. Leave out a number only when its passage has nothing to do with the query.',
    `Query: ${query}`,
    'Passages:',
    blocks,
    'JSON array:',
  ].join('\n\n');
}

/** Parse the model's answer into 0-based positions; null when it is not a clean permutation of a subset of 1..count. */
export function parseRerankOutput(raw: string, count: number): number[] | null {
  const match = raw.match(/\[[\d,\s]*\]/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<number>();
  const order: number[] = [];
  for (const n of parsed) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > count || seen.has(n)) {
      return null;
    }
    seen.add(n);
    order.push(n - 1);
  }
  return order;
}

/** Ranked candidates first in the model's order, then every omitted one in its original (RRF) order. */
export function applyRerankOrder<T>(candidates: T[], order: number[]): T[] {
  const placed = new Set(order);
  const ranked = order.map((i) => candidates[i]).filter((c): c is T => c !== undefined);
  const omitted = candidates.filter((_, i) => !placed.has(i));
  return [...ranked, ...omitted];
}

// cm:guard the key covers the ids IN SUBMITTED ORDER and the sha of every text, never a sorted id set — a cached value is the complete ordering of one submitted set, so the same ids in another order or one id whose text changed must miss; keying on sorted ids let the predecessor serve a stale ordering (proposal review, 2026-09-04)
export function rerankCacheKey(model: string, query: string, hits: MemoryHit[]): string {
  const h = createHash('sha256');
  h.update(model).update('|').update(query);
  for (const hit of hits) {
    h.update('|').update(hit.id).update(':');
    h.update(createHash('sha256').update(shownText(hit)).digest('hex'));
  }
  return h.digest('hex');
}

const cache = new Map<string, { order: number[]; at: number }>();

function cacheGet(key: string, now: number): number[] | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.order;
}

function cacheSet(key: string, order: number[], now: number): void {
  cache.set(key, { order, at: now });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function resetRerankCache(): void {
  cache.clear();
}

function maxTokensFor(count: number): number {
  return Math.max(32, count * 4 + 16);
}

async function orderFromModel(query: string, hits: MemoryHit[]): Promise<number[] | null> {
  const model = rerankModel();
  const key = rerankCacheKey(model, query, hits);
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached) return cached;
  const raw = await callFastModel(
    buildRerankPrompt(query, hits.map(shownText)),
    maxTokensFor(hits.length),
    { model },
  );
  if (raw === null) return null;
  const order = parseRerankOutput(raw, hits.length);
  if (order === null) {
    logger.warn({ model, sample: raw.slice(0, 120) }, 'memory.rerank: output was not a ranking');
    return null;
  }
  cacheSet(key, order, now);
  return order;
}

/** Rerank `hits` and cut to `topK`; on any failure the RRF order is cut to `topK` instead. */
export async function rerankHits(input: RerankInput): Promise<RerankResult> {
  const startedAt = Date.now();
  const order = input.hits.length > 1 ? await orderFromModel(input.query, input.hits) : null;
  const rerankMs = Date.now() - startedAt;
  if (order === null) {
    return { hits: input.hits.slice(0, input.topK), reranked: false, rerankMs };
  }
  const hits = applyRerankOrder(input.hits, order)
    .slice(0, input.topK)
    .map((hit, i) => ({ ...hit, rerankPosition: i }));
  return { hits, reranked: true, rerankMs };
}
