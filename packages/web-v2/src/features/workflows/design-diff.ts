import type { DesignDiffView, DiffMark } from "@forge/contracts/workflow-health";
import type { WorkflowBody, WorkflowStep } from "./types";

export type StepMark = DiffMark;

/** Core's diff of the proposed revision against the approved one (workflow-step-health `bkm-diff`), as the canvas draws it. */
export interface DesignDiff {
  steps: Map<string, StepMark>;
  edges: Map<string, StepMark>;
  /** The approved steps the proposal removes, kept so they are drawn in place. */
  removed: WorkflowStep[];
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** The diff core served, with the removed steps taken from the approved document it was read against. */
export function diffOf(view: DesignDiffView, approved: WorkflowBody): DesignDiff {
  const steps = new Map(Object.entries(view.steps));
  return {
    steps,
    edges: new Map(Object.entries(view.edges)),
    removed: approved.steps.filter((s) => steps.get(s.id) === "removed"),
  };
}

/** The steps drawn with the diff on: the proposed ones, and the approved ones it removes, kept in place. */
export function stepsWithRemoved(proposed: WorkflowBody, diff: DesignDiff | null): WorkflowStep[] {
  if (!diff || diff.removed.length === 0) return proposed.steps;
  const ids = new Set([...proposed.steps.map((s) => s.id), ...diff.removed.map((s) => s.id)]);
  return [...proposed.steps, ...diff.removed.map((s) => ({ ...s, after: s.after.filter((a) => ids.has(a)) }))];
}
