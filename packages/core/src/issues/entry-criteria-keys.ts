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
