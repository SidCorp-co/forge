export const jobEventKinds = [
  'stdout',
  'stderr',
  'tool_call',
  'tool_result',
  'progress',
  'result',
  'intervention',
  'kill_ack',
  'secret_resolve',
] as const;
export type JobEventKind = (typeof jobEventKinds)[number];

// core writes these rows itself; a box that could post one would forge an audit row.
export const CORE_WRITTEN_JOB_EVENT_KINDS = [
  'intervention',
  'kill_ack',
  'secret_resolve',
] as const satisfies readonly JobEventKind[];

export const DEVICE_POSTED_JOB_EVENT_KINDS = jobEventKinds.filter(
  (k): k is Exclude<JobEventKind, (typeof CORE_WRITTEN_JOB_EVENT_KINDS)[number]> =>
    !(CORE_WRITTEN_JOB_EVENT_KINDS as readonly string[]).includes(k),
);
