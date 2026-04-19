/**
 * BM25 tokenizer and sparse vector builder for hybrid search.
 * Computes term frequency / inverse document frequency weights
 * and maps tokens to sparse vector indices via FNV-1a hashing.
 */

// Reuse stopwords from entity-index for consistency
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'are', 'was',
  'be', 'has', 'had', 'have', 'will', 'can', 'do', 'does', 'did', 'not',
  'no', 'so', 'if', 'its', 'any', 'all', 'new', 'one', 'two', 'may',
  'also', 'than', 'more', 'some', 'what', 'when', 'who', 'how', 'which',
  'about', 'into', 'been', 'would', 'could', 'should', 'just', 'there',
  'then', 'now', 'each', 'only', 'very', 'other', 'our', 'your', 'their',
]);

// BM25 parameters
const K1 = 1.2;
const B = 0.75;
const AVG_DOC_LENGTH = 150; // approximate average tokens per chunk

// Sparse vector dimension — large enough to minimise hash collisions
const SPARSE_DIM = 30_000;

/**
 * FNV-1a hash to map a token string to a sparse vector index.
 * Deterministic and fast, returns value in [0, SPARSE_DIM).
 */
export function tokenToIndex(token: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, unsigned
  }
  return hash % SPARSE_DIM;
}

/**
 * Tokenize text into a term frequency map.
 * Lowercases, splits on whitespace/punctuation, removes stopwords,
 * and applies simple suffix stemming.
 */
export function tokenize(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  const words = text.toLowerCase().split(/[\s\n\r\t,.;:!?()\[\]{}"'`/\\|@#$%^&*+=<>~]+/);

  for (const raw of words) {
    const word = raw.replace(/[^a-z0-9-]/g, '');
    if (word.length < 2 || STOPWORDS.has(word)) continue;

    // Simple suffix stemming for English plurals/verb forms
    const stemmed = simpleStem(word);
    tf.set(stemmed, (tf.get(stemmed) || 0) + 1);
  }

  return tf;
}

/**
 * Very lightweight stemmer — handles common English suffixes.
 * Not a full Porter stemmer, but sufficient for BM25 matching.
 */
function simpleStem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('tion') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ness') && word.length > 5) return word.slice(0, -4);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

/**
 * Build a BM25 sparse vector from tokenized text.
 * Uses BM25 formula: weight = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl/avgdl))
 * IDF is applied at query time (not stored in document vectors).
 */
export function buildDocSparseVector(text: string, metadataText?: string): SparseVector {
  const fullText = metadataText ? `${text} ${metadataText}` : text;
  const tf = tokenize(fullText);
  const docLength = Array.from(tf.values()).reduce((sum, v) => sum + v, 0);

  const indexMap = new Map<number, number>();

  for (const [token, freq] of tf) {
    const idx = tokenToIndex(token);
    // BM25 term frequency saturation (without IDF — applied at query time)
    const tfNorm = (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * docLength / AVG_DOC_LENGTH));

    // Handle hash collisions by summing (rare with 30K dimensions)
    indexMap.set(idx, (indexMap.get(idx) || 0) + tfNorm);
  }

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, val] of indexMap) {
    indices.push(idx);
    values.push(val);
  }

  return { indices, values };
}

/**
 * Build a BM25 sparse query vector.
 * Each query term gets weight 1.0 (IDF-like boost for rare terms
 * is handled implicitly — rare terms match fewer documents in Qdrant).
 */
export function buildQuerySparseVector(query: string): SparseVector {
  const tf = tokenize(query);
  const indexMap = new Map<number, number>();

  for (const [token, freq] of tf) {
    const idx = tokenToIndex(token);
    // Query terms weighted by frequency, capped at 1.0 per unique token
    indexMap.set(idx, (indexMap.get(idx) || 0) + Math.min(freq, 1.0));
  }

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, val] of indexMap) {
    indices.push(idx);
    values.push(val);
  }

  return { indices, values };
}

/**
 * Build metadata text string for BM25 indexing.
 * Includes metadata fields so they're searchable via keyword match.
 */
export function buildMetadataText(metadata: Record<string, any>): string {
  const parts: string[] = [];
  for (const key of ['title', 'status', 'priority', 'category', 'role', 'scope', 'name', 'section']) {
    const val = metadata[key];
    if (val && typeof val === 'string') parts.push(val);
  }
  return parts.join(' ');
}
