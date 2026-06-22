// web-v2 feature module: improvement-messages — shapes verified against
// `packages/core/src/improvement-messages/routes.ts` (ISS-549).
// Cross-app parity type is also exported from packages/contracts/src/rows.ts.
import type { ScheduleRun } from "@/features/schedules/types";

export type ImprovementMessageCategory =
  | "code-quality"
  | "testing"
  | "documentation"
  | "performance"
  | "security"
  | "dx"
  | "ops"
  | "general";

export interface ImprovementMessage {
  key: string;
  title: string;
  message: string;
  rationale: string;
  appliesToSkills?: readonly string[];
  appliesWhen?: string;
  category: ImprovementMessageCategory;
  version: number;
  recommended: boolean;
  defaultMode: "propose" | "auto";
}

export interface ImprovementMessageEnablement {
  enabled: boolean;
  scheduleId: string;
  mode: string;
  cron: string;
}

export interface ImprovementMessageEntry extends ImprovementMessage {
  enablement: ImprovementMessageEnablement | null;
}

/** Payload for enabling a message (creates a schedule). */
export interface EnableMessagePayload {
  projectId: string;
  templateKey: string;
  mode: "propose" | "auto";
  cron: string;
}

/** Cadence preset for the cadence picker. */
export interface CadencePreset {
  label: string;
  cron: string;
}

export const CADENCE_PRESETS: CadencePreset[] = [
  { label: "Daily", cron: "0 9 * * *" },
  { label: "Weekly", cron: "0 9 * * 1" },
];

export const MODE_OPTIONS: { label: string; value: "propose" | "auto" }[] = [
  { label: "Propose", value: "propose" },
  { label: "Auto", value: "auto" },
];

export const CATEGORY_LABELS: Record<ImprovementMessageCategory, string> = {
  "code-quality": "Code Quality",
  testing: "Testing",
  documentation: "Documentation",
  performance: "Performance",
  security: "Security",
  dx: "DX",
  ops: "Ops",
  general: "General",
};

// Re-export ScheduleRun for use in the run log since improvement messages
// use the same /api/schedules/:id/runs endpoint.
export type { ScheduleRun };
