import crypto from 'crypto';
import type { SearchResult } from './index';

export interface CrossEncoderResult extends SearchResult {
  crossEncoderScore: number;
}

const CACHE_TTL = 300_000; // 5 minutes
const CACHE_MAX = 500;
const CLEANUP_INTERVAL = 60_000; // 1 minute

const cache = new Map<string, { results: CrossEncoderResult[]; timestamp: number }>();

// Periodic cleanup of expired entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL) cache.delete(key);
  }
}, CLEANUP_INTERVAL);
cleanupTimer.unref?.();

/** Providers that support the native /rerank endpoint */
const NATIVE_RERANK_PREFIXES = ['cohere/', 'jina/', 'together_ai/', 'voyage/'];

// Startup diagnostic — logs once when module is first imported
setTimeout(() => {
  const _rerankModel = process.env.LITELLM_RERANK_MODEL;
  const _apiUrl = process.env.LITELLM_API_URL;
  const log = (globalThis as any).strapi?.log;
  if (_rerankModel && _apiUrl) {
    const mode = NATIVE_RERANK_PREFIXES.some((p) => _rerankModel.startsWith(p)) ? 'native /rerank' : 'LLM /chat/completions';
    log?.info?.(`[cross-encoder] enabled: model=${_rerankModel}, mode=${mode}, api=${_apiUrl}`);
  } else {
    log?.info?.(`[cross-encoder] disabled: LITELLM_RERANK_MODEL=${_rerankModel || '(not set)'}, LITELLM_API_URL=${_apiUrl ? 'set' : '(not set)'}`);
  }
}, 5000); // delay to ensure strapi.log is available

function buildCacheKey(query: string, results: SearchResult[]): string {
  const ids = results
    .map((r) => `${r.payload.source_type}:${r.payload.source_id}:${r.payload.chunk_index}`)
    .sort()
    .join(',');
  return crypto.createHash('sha256').update(`${query}|${ids}`).digest('hex');
}

function isNativeRerankModel(model: string): boolean {
  return NATIVE_RERANK_PREFIXES.some((p) => model.startsWith(p));
}

/**
 * Check if cross-encoder reranking is enabled.
 */
export function isCrossEncoderEnabled(): boolean {
  return !!process.env.LITELLM_RERANK_MODEL && !!process.env.LITELLM_API_URL;
}

/**
 * Rerank results using either native /rerank endpoint or LLM-based reranking.
 * Returns null if disabled or on failure (caller falls back to heuristic-only).
 */
export async function crossEncoderRerank(
  query: string,
  results: SearchResult[],
  topK: number,
): Promise<CrossEncoderResult[] | null> {
  const log = (globalThis as any).strapi?.log;

  if (!isCrossEncoderEnabled() || results.length === 0) {
    if (results.length > 0) {
      log?.debug?.(`[cross-encoder] skipped: enabled=${isCrossEncoderEnabled()}, LITELLM_RERANK_MODEL=${process.env.LITELLM_RERANK_MODEL || '(not set)'}`);
    }
    return null;
  }

  log?.debug?.(`[cross-encoder] starting rerank: query="${query.slice(0, 50)}", ${results.length} candidates, topK=${topK}`);

  const cacheKey = buildCacheKey(query, results);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }

  const model = process.env.LITELLM_RERANK_MODEL!;
  const start = Date.now();

  const reranked = isNativeRerankModel(model)
    ? await nativeRerank(query, results, topK, model)
    : await llmRerank(query, results, topK, model);

  if (!reranked) return null;

  const elapsed = Date.now() - start;
  log?.info?.(`[cross-encoder] reranked ${results.length}→${reranked.length} in ${elapsed}ms (${model})`);

  // Cache the results
  if (cache.size >= CACHE_MAX) {
    let oldest: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldest = key;
      }
    }
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey, { results: reranked, timestamp: Date.now() });

  return reranked;
}

/**
 * Native /rerank endpoint (Cohere, Jina, Together, Voyage).
 */
async function nativeRerank(
  query: string,
  results: SearchResult[],
  topK: number,
  model: string,
): Promise<CrossEncoderResult[] | null> {
  const apiUrl = process.env.LITELLM_API_URL!;
  const apiKey = process.env.LITELLM_API_KEY;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${apiUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        query,
        documents: results.map((r) => r.payload.text),
        top_n: Math.min(topK, results.length),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const log = (globalThis as any).strapi?.log;
      log?.warn?.(`[cross-encoder] native rerank failed: ${response.status} ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    return data.results.map((r) => ({
      ...results[r.index],
      crossEncoderScore: r.relevance_score,
    }));
  } catch (err: any) {
    const log = (globalThis as any).strapi?.log;
    if (err.name === 'AbortError') {
      log?.warn?.(`[cross-encoder] native rerank timed out`);
    } else {
      log?.warn?.(`[cross-encoder] native rerank failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * LLM-based reranking via /chat/completions (Gemini, OpenAI, etc.).
 * Sends documents in a single prompt, asks the LLM to score relevance 0-1.
 */
async function llmRerank(
  query: string,
  results: SearchResult[],
  topK: number,
  model: string,
): Promise<CrossEncoderResult[] | null> {
  const apiUrl = process.env.LITELLM_API_URL!;
  const apiKey = process.env.LITELLM_API_KEY;

  // Truncate documents to keep prompt manageable
  const maxDocLen = 300;
  const docs = results.map((r, i) => {
    const text = r.payload.text.length > maxDocLen
      ? r.payload.text.slice(0, maxDocLen) + '...'
      : r.payload.text;
    return `[${i}] ${text}`;
  });

  const prompt = `You are a relevance scoring engine. Given a query and a list of documents, score each document's relevance to the query on a scale of 0.0 to 1.0.

Query: "${query}"

Documents:
${docs.join('\n\n')}

Return ONLY a JSON array of objects with "index" (number) and "score" (number 0.0-1.0), sorted by score descending. Return the top ${Math.min(topK, results.length)} most relevant documents. No explanation, no markdown fences.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // LLM needs more time

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const log = (globalThis as any).strapi?.log;
      log?.warn?.(`[cross-encoder] llm rerank failed: ${response.status} ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content || '';

    // Extract JSON array from response (handle possible markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      const log = (globalThis as any).strapi?.log;
      log?.warn?.(`[cross-encoder] llm rerank: failed to parse response`);
      return null;
    }

    const scored = JSON.parse(jsonMatch[0]) as Array<{ index: number; score: number }>;

    return scored
      .filter((s) => s.index >= 0 && s.index < results.length && typeof s.score === 'number')
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => ({
        ...results[s.index],
        crossEncoderScore: s.score,
      }));
  } catch (err: any) {
    const log = (globalThis as any).strapi?.log;
    if (err.name === 'AbortError') {
      log?.warn?.(`[cross-encoder] llm rerank timed out`);
    } else {
      log?.warn?.(`[cross-encoder] llm rerank failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * Build a score map from cross-encoder results for use with heuristic reranker.
 */
export function buildScoreMap(results: CrossEncoderResult[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of results) {
    const key = `${r.payload.source_type}:${r.payload.source_id}:${r.payload.chunk_index}`;
    map.set(key, r.crossEncoderScore);
  }
  return map;
}
