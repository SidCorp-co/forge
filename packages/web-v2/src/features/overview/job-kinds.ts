import type { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";

type JobType = (typeof REGISTRY_JOB_TYPES)[number];

/**
 * Each kind of work a project runs, in a reader's words. Every kind is its own work and none feeds
 * the next, so none of these is a stage. Exhaustive over the registry, so a new job type is a build
 * error here rather than a stored value on the screen.
 */
export const JOB_KIND_LABEL: Record<JobType, string> = {
  drive: "Issue work",
  release_batch: "Releases",
  reconcile: "Skill updates",
  verify_skill: "Skill checks",
  smoke: "Skill trial runs",
  pm: "Project manager",
  custom: "Custom prompts",
};

/** The label for a type read off the wire; one this build does not know is named as such, not shown raw. */
export function jobKindLabel(type: string): string {
  return JOB_KIND_LABEL[type as JobType] ?? `Unrecognised work (${type})`;
}
