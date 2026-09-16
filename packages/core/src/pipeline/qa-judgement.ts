/**
 * Who judges a change between `developed` and `testing` — the project's answer, stored once.
 *
 * `independent` — a run other than the one that built the change writes the verdicts.
 * `builder` — the run that built it judges its own work.
 *
 * The key and both spellings live HERE and nowhere else, because they are read across a repository
 * boundary this repo cannot gate and were unreadable for four weeks without anyone noticing.
 */
// cm:guard CROSS-REPO, so no `cm:edge` can hold it: `plugin/src/tracker/project-config.mjs` in
// github.com/SidCorp-co/forge-plugin reads `config.pipelineConfig.qa` and matches it against its own
// `QA_MODES = ["independent", "builder"]`, rendering the result as the `independent judgement` row
// that issue-flow Phase 0 is told to read before Phase 3 plans against it. Before ISS-1046 this key
// was not in `pipelineConfigSchema` at all and that schema strips unknown keys, so the write was a
// 200 that stored nothing and `judgementOf()` answered `not stated` on all 32 projects by
// construction — indistinguishable from a project that had not decided.
// cm:guard what a gate in THIS repo can hold is that every reader here matches this constant, which
// `qa-judgement.test.ts` does. It cannot see the other repo: a rename on the plugin side reds
// nothing here and stays invisible, and that half is a row on the forge-plugin project.
export const QA_JUDGEMENT_KEY = 'qa' as const;

export const QA_JUDGEMENT_MODES = ['independent', 'builder'] as const;

export type QaJudgementMode = (typeof QA_JUDGEMENT_MODES)[number];
