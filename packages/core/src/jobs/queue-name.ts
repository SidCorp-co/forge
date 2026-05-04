export const JOB_QUEUE_NAME = 'forge.jobs';

// PM workload runs through a separate pg-boss queue so a PM backlog cannot
// stall coder dispatch (and vice versa). See ISS-18.
export const PM_QUEUE_NAME = 'forge.pm-jobs';
