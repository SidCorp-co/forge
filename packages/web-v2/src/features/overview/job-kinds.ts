import type { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";

type JobType = (typeof REGISTRY_JOB_TYPES)[number];

/** Each kind of work in a reader's words; none feeds the next, so none is a stage. Exhaustive,
 *  so a new job type is a build error here rather than a stored value on screen. */
export const JOB_KIND_LABEL: Record<JobType, string> = {
  drive: "Issue work",
  release_batch: "Releases",
  reconcile: "Skill updates",
  verify_skill: "Skill checks",
  smoke: "Skill trial runs",
  pm: "Project manager",
  custom: "Custom prompts",
};

export function jobKindLabel(type: string): string {
  return JOB_KIND_LABEL[type as JobType] ?? `Unrecognised work (${type})`;
}
