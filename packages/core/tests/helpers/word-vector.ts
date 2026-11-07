import { MEMORY_EMBEDDING_DIM } from '../../src/db/schema-types.js';

/**
 * A stand-in for the embeddings model in a test: each distinct word of any script, lower-cased, adds
 * one to a dimension its hash picks, so two texts are as close as the words they share and the same
 * text is the same vector. It proves what recall does with a vector, never how good a model's is.
 */
export function wordVector(text: string): number[] {
  const v = new Array<number>(MEMORY_EMBEDDING_DIM).fill(0);
  for (const word of new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
    v[h % MEMORY_EMBEDDING_DIM] = (v[h % MEMORY_EMBEDDING_DIM] ?? 0) + 1;
  }
  // an empty text still embeds: a zero vector has no direction for a cosine to read
  if (v.every((x) => x === 0)) v[0] = 1;
  return v;
}
