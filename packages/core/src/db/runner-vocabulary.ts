export const runnerTypes = ['claude-code'] as const;
export type RunnerType = (typeof runnerTypes)[number];

export const runnerStatuses = ['online', 'offline', 'draining', 'disabled'] as const;
export type RunnerStatus = (typeof runnerStatuses)[number];
