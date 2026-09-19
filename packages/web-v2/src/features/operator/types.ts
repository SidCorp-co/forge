
export type {
  AdminAdoptionBucket,
  AdminAlert,
  AdminAlertEntity,
  AdminAlertId,
  AdminAlertStatus,
  AdminGlanceMetric,
  AdminOverview,
  AdminWorkspaceRow,
} from "@forge/contracts";

export type OperatorSectionKey =
  | "overview"
  | "alerts"
  | "fleet"
  | "pipeline"
  | "growth"
  | "mcp-logs";

/** The three windows `GET /api/admin/overview` and `/workspaces` accept. */
export type OperatorWindow = "24h" | "7d" | "30d";

/** The three orderings `GET /api/admin/workspaces` accepts. */
export type OperatorWorkspaceSort = "runs" | "spend" | "leadTime";

export interface OperatorWhoami {
  isAdmin: boolean;
  email: string;
}

export type OperatorWhoamiResult =
  | { kind: "admin"; email: string }
  | { kind: "not-admin" }
  | { kind: "unverified" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };
