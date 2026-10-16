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

/** A stored name nobody gave words to, in its own words, so a reader is shown no code. */
export function storedNameInWords(type: string): string {
  const words = type.split(/[_\-\s]+/).filter(Boolean).join(" ").toLowerCase();
  return words === "" ? "Unnamed work" : words.charAt(0).toUpperCase() + words.slice(1);
}

export function jobKindLabel(type: string): string {
  return JOB_KIND_LABEL[type as JobType] ?? storedNameInWords(type);
}
