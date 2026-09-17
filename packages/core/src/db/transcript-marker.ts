/**
 * ISS-1027 — the two keys that say what happened to a session's transcript, and
 * the merges that write them.
 *
 * They live here, beside `kernel-marker.ts`, because the writer and the reader
 * are in different modules and must not import each other: `jobs/session-
 * transcript.ts` stamps them and `pipeline/retention/statements.ts` reads them, so a
 * constant owned by either one makes the two modules circular. A string
 * duplicated across that boundary instead would fail the only way that matters
 * — silently, with the sweep finding no finalised session and holding every
 * job's events for ever.
 *
 * Both writes MERGE into `agent_sessions.metadata`. That column carries live
 * keys other writers own (`conversationAgent`, `deviceId`, the member-lens
 * override), so a write that rebuilt the object would drop every key it did not
 * resend — the `wholesale-config-clobber` shape.
 */

import { type SQL, sql } from 'drizzle-orm';

/**
 * Stamped by `deriveSessionFinal`, in the same transaction that stores the
 * transcript it finalises, so the marker can only ever describe a write that
 * committed. An incremental flush never writes it: the two paths share one
 * writer, so a non-empty transcript proves a derive ran and nothing about which
 * one, which is why this key exists at all.
 */
export const TRANSCRIPT_FINALIZED_KEY = 'transcriptFinalizedAt';

/**
 * Stamped by the retention repair pass BEFORE it tries to finalise, so a
 * session that throws — or that takes the process down mid-derive — rotates
 * behind the ones not yet tried instead of taking every night's budget.
 */
export const TRANSCRIPT_ATTEMPTED_KEY = 'transcriptFinalizeAttemptedAt';

/** `metadata` with one key merged in, for a drizzle `.set()` or a raw UPDATE. */
// cm:guard both parameters carry an explicit `::text`, and the KEY one is not decoration: without it Postgres cannot resolve which `jsonb_build_object` overload is meant and answers `could not determine data type of parameter $1`. It surfaced as no marker being written at all, because the sweep's repair pass catches per session so one bad row cannot take the tick down — a cast this small failing silently is exactly what that catch would have hidden.
export function mergeMetadataKey(key: string, value: string): SQL {
  return sql`coalesce(metadata, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)`;
}

/** The merge the final derive puts in its own SET list. */
export function finalizedMerge(at: Date): SQL {
  return mergeMetadataKey(TRANSCRIPT_FINALIZED_KEY, at.toISOString());
}

/** The merge the repair pass stamps before it tries. */
export function attemptedMerge(at: Date): SQL {
  return mergeMetadataKey(TRANSCRIPT_ATTEMPTED_KEY, at.toISOString());
}
