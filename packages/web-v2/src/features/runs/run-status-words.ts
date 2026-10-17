import { STOPPED_WORD } from "@/design";
import type { PipelineRunStatus } from "./types";

/** A run's status in a reader's words, the same on the runs list and a release run's page. */
export const RUN_STATUS_WORD: Record<PipelineRunStatus, string> = {
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: STOPPED_WORD,
};
