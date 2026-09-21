import { type SQL, sql } from 'drizzle-orm';

export const TRANSCRIPT_FINALIZED_KEY = 'transcriptFinalizedAt';

export const TRANSCRIPT_ATTEMPTED_KEY = 'transcriptFinalizeAttemptedAt';

export function mergeMetadataKey(key: string, value: string): SQL {
  return sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)`;
}

export function finalizedMerge(at: Date): SQL {
  return mergeMetadataKey(TRANSCRIPT_FINALIZED_KEY, at.toISOString());
}

/** The merge the repair pass stamps before it tries. */
export function attemptedMerge(at: Date): SQL {
  return mergeMetadataKey(TRANSCRIPT_ATTEMPTED_KEY, at.toISOString());
}
