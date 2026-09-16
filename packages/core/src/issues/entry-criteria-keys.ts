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
export const ENTRY_CRITERION_KEYS = [
  'plan',
  'acceptance_criteria',
  'release_note',
  'work_evidence',
  'merged_mark',
] as const;

export type EntryCriterionKey = (typeof ENTRY_CRITERION_KEYS)[number];
