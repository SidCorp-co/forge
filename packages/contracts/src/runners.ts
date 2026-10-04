// The codes a runner binding is refused by, in the 422 envelope.

export const RUNNER_REFUSAL_CODES = ["RUNNER_REFUSED", "RUNNER_ALREADY_BOUND"] as const;

export type RunnerRefusalCode = (typeof RUNNER_REFUSAL_CODES)[number];
