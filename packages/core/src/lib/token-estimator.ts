/**
 * Lightweight token estimator for prompt cost preview / block contribution
 * analysis. Pure heuristic — no model call, no tokenizer dep — sized to be
 * within ~10% of Anthropic SDK tokenizer output for English / code text.
 *
 * Use it for budget estimation, block breakdown, and analytics. Do NOT use
 * for billing — the canonical token counts come from Claude API's
 * `usage.input_tokens` after the request.
 *
 * Heuristic: ~3.6 chars/token for mixed English + code. Adjusts upward for
 * very long strings (tokenizers split rare/long sequences more aggressively)
 * and downward for short strings (overhead of BOS/special tokens).
 */

const CHARS_PER_TOKEN = 3.6;
const SHORT_THRESHOLD = 32;
const LONG_THRESHOLD = 4000;

function rawEstimate(text: string): number {
  if (text.length === 0) return 0;
  let n = text.length / CHARS_PER_TOKEN;
  // Very short: tokenizer overhead inflates ratio slightly.
  if (text.length < SHORT_THRESHOLD) n *= 1.15;
  // Very long: more rare-token splits, increases ratio.
  if (text.length > LONG_THRESHOLD) n *= 1.05;
  return Math.ceil(n);
}

/**
 * Simple FIFO LRU. Map preserves insertion order; we evict the oldest
 * entry when over capacity. Cheap enough that we don't need a real LRU.
 */
class TokenCache {
  private readonly map = new Map<string, number>();
  private readonly cap: number;
  private hits = 0;
  private misses = 0;

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): number | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits += 1;
      // Touch to move to end (LRU semantics on top of insertion-ordered map).
      this.map.delete(key);
      this.map.set(key, v);
    } else {
      this.misses += 1;
    }
    return v;
  }

  set(key: string, value: number): void {
    if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

const cache = new TokenCache(200);

/**
 * Cheap content hash for cache key. We don't need cryptographic strength —
 * just collision-resistant enough for 200 cache entries. FNV-1a 32-bit
 * mixed with length is fine; runs in ~µs for 10KB strings.
 */
function hashKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Estimate input tokens for a text. Cached by content hash so repeat calls
 * for the same prompt prefix (eg. pipeline preamble across jobs) are O(1).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const key = hashKey(text);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = rawEstimate(text);
  cache.set(key, value);
  return value;
}

export function getTokenEstimatorCacheStats(): {
  hits: number;
  misses: number;
  size: number;
} {
  return cache.stats();
}

export function clearTokenEstimatorCache(): void {
  cache.clear();
}
