/**
 * ISS-959 — the criterion vocabulary, alone in a module that imports nothing.
 *
 * `pipeline-config-schema.ts` validates a project's `statusEntryCriteria`
 * against this list, and `entry-criteria.ts` evaluates it. Those two cannot
 * share a module: the evaluator reads the database and the config it reads is
 * parsed BY that schema, so one file holding both puts `db/client.ts` (and its
 * eager env validation) behind every import of the schema and closes the loop
 * schema → entry-criteria → autonomous-project → schema.
 */
// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts — `statusEntryCriteria` is a `z.enum` of exactly this array, so a key added here becomes declarable and a key removed here makes every project that already declared it fail its next config save. Removing one is a data change, not a rename.
// cm:edge lockstep -> packages/core/src/issues/entry-criteria.ts — every key here needs an entry in that module's `CRITERIA` map, which is exhaustive by type; a key with no criterion would be a declaration that silently checks nothing.
export const ENTRY_CRITERION_KEYS = [
  'plan',
  'acceptance_criteria',
  'release_note',
  'work_evidence',
  'merged_mark',
] as const;

export type EntryCriterionKey = (typeof ENTRY_CRITERION_KEYS)[number];

/**
 * The `issues` columns a declared criterion reads. ISS-1072.
 *
 * Here rather than in `entry-criteria.ts` because the writer that must announce
 * a move — `issues/update-service.ts` — cannot import that module: it reads the
 * database and the config schema behind it, and the loop the header above
 * describes is exactly what a shared constant in this file avoids.
 *
 * `sessionContext` is on the list and is not a criterion of its own: it is what
 * `work_evidence` reads a branch out of, so writing it moves the contract's
 * answer without any key here being named.
 */
// cm:edge lockstep -> packages/core/src/issues/entry-criteria.ts — every criterion's reader must have its column here, or a write of that column leaves a published check run stale with nothing to say so.
export const CONTRACT_INPUT_FIELDS = [
  'plan',
  'acceptanceCriteria',
  'releaseNotes',
  'mergedAt',
  'sessionContext',
] as const;
