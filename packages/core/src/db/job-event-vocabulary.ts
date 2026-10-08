export const jobEventKinds = [
  'stdout',
  'stderr',
  'tool_call',
  'tool_result',
  'progress',
  'result',
  // An audited manual intervention, such as a single-job cancel; the interventions metric counts it.
  'intervention',
  'kill_ack',
] as const;
export type JobEventKind = (typeof jobEventKinds)[number];
