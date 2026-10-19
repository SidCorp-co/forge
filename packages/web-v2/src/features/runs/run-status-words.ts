import { STOPPED_WORD } from "@/design";
import type { PipelineRunKind, PipelineRunStatus } from "./types";

/** A run's status in a reader's words, the same on the runs list and a release run's page. */
export const RUN_STATUS_WORD: Record<PipelineRunStatus, string> = {
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: STOPPED_WORD,
};

/** A run that names no issue, by its kind, the same on the runs tab and as its drawer's title. */
export const RUN_KIND_WORD: Record<PipelineRunKind, string> = {
  issue: "Issue run",
  pm: "Project manager run",
  interactive: "Chat run",
  system: "System run",
};
