export const JOB_QUEUE_NAME = 'forge.jobs';

// PM workload runs through a separate pg-boss queue so a PM backlog cannot
// stall coder dispatch (and vice versa). See ISS-18.
export const PM_QUEUE_NAME = 'forge.pm-jobs';

// ISS-234 — Integration framework outbound dispatch. Each provider's
// dispatchOutbound runs on this queue with retry: 5x exponential backoff so
// Coolify deploys (and future Sentry / Human-Task calls) survive transient
// API blips without manual intervention.
export const INTEGRATIONS_QUEUE_NAME = 'forge.integrations';
