/**
 * The store's similarity thresholds, in a module that imports nothing: read by the indexer and by
 * the assistant's memory-note gate (ISS-1064), whose rules must load without a database.
 */

/** Cosine similarity at or above which a write is a near-duplicate of a row already held. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
