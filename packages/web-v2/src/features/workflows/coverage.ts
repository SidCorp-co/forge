import type { WorkflowStep } from "./types";

/** How many of a flow's steps the integration suite walks, out of how many it has. */
export function walkedOf(steps: readonly WorkflowStep[]): { walked: number; total: number } {
  return {
    walked: steps.filter((s) => s.evidence?.coverage?.reading === "walked").length,
    total: steps.length,
  };
}
