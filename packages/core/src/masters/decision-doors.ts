import type { StandingSubjectKind } from '@forge/contracts/steward';

/** An item a decision is recorded on, as a wake line names it: its kind and its key. */
export interface DecidedItem {
  kind: StandingSubjectKind;
  key: string;
}

/**
 * The door that records a decision on an item of each kind (ISS-654, ISS-1282): an issue's
 * `decision` record, or the decision comment a feedback item, a requirement or a workflow takes,
 * which `comments/decision-answers.ts` reads. The issue door answers 404 for any other kind, so a
 * line names the door of each item's own kind. Its bound, `until` or `reversedWhen`, is a date the
 * decision holds until or a condition it holds under; the line naming the doors says how long.
 */
const DECISION_DOOR: Record<StandingSubjectKind, (keys: string) => string> = {
  issue: (keys) =>
    `on an issue (${keys}), \`forge-runner api issues/<id>/events -X POST\` with the body \`{"kind":"decision","contract":1,"fields":[{"key":"decision","value":"…"},{"key":"why","value":"…"}]}\`, plus a field \`until\` holding a date (ISO 8601, such as 2026-11-01) or a condition`,
  feedback: (keys) =>
    `on a feedback item (${keys}), \`forge-runner api projects/<projectId>/feedback/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason, reversedWhen }\`, \`reversedWhen\` inside \`decision\` holding a date (ISO 8601, such as 2026-11-01) or a condition`,
  requirement: (keys) =>
    `on a requirement (${keys}), \`forge-runner api projects/<projectId>/requirements/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason, reversedWhen }\`, \`reversedWhen\` inside \`decision\` holding a date (ISO 8601, such as 2026-11-01) or a condition`,
  workflow: (keys) =>
    `on a workflow (${keys}), \`forge-runner api projects/<projectId>/workflows/<flow>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason, reversedWhen }\`, \`reversedWhen\` inside \`decision\` holding a date (ISO 8601, such as 2026-11-01) or a condition`,
};

const KINDS = ['issue', 'feedback', 'requirement', 'workflow'] as const;

/** The decision door of each kind among `items`, with its keys, and of no kind absent from them. */
export function decisionDoors(items: readonly DecidedItem[]): string[] {
  return KINDS.flatMap((kind) => {
    const keys = [...new Set(items.filter((i) => i.kind === kind).map((i) => i.key))];
    return keys.length > 0 ? [DECISION_DOOR[kind](keys.join(', '))] : [];
  });
}
