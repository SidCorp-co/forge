/**
 * What species of session a row is — the fact five writers used to leave in a
 * jsonb key that two of them forgot (ISS-1136).
 *
 * `pipeline` and `pm` are job-driven; `master` is a box's resident dispatcher;
 * `run_session` is one dispatch of work on a box; `chat` is everything a person
 * or a schedule starts by talking. A sixth species is one migration and one
 * entry here, and nothing else.
 *
 * Here rather than in `schema.ts` because `schema.ts` is already over the size
 * budget, and a vocabulary is not a table.
 */
export const agentSessionKinds = ['master', 'run_session', 'pipeline', 'pm', 'chat'] as const;

export type AgentSessionKind = (typeof agentSessionKinds)[number];
