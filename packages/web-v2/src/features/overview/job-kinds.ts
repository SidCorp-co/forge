import type { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";

type JobType = (typeof REGISTRY_JOB_TYPES)[number];

/** Each kind of work in a reader's words; exhaustive, so a new job type is a build error here. */
export const JOB_KIND_LABEL: Record<JobType, string> = {
  drive: "Issue work",
  release_batch: "Releases",
  reconcile: "Skill updates",
  verify_skill: "Skill checks",
  smoke: "Skill trial runs",
  pm: "Project manager",
  custom: "Custom prompts",
};

/** A stored name with no words reads as unknown beside it: made-up words would pass as known (ISS-1229). */
export function unrecognised(noun: string, stored: string): string {
  const name = stored.trim();
  return name === "" ? `Unrecognised ${noun}` : `Unrecognised ${noun} (${name})`;
}

export function jobKindLabel(type: string): string {
  return JOB_KIND_LABEL[type as JobType] ?? unrecognised("work", type);
}
