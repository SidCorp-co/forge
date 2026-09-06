/* Operator Ops Console — types. The four cross-tenant response shapes come
   from `@forge/contracts` (ISS-653), which is the module's only non-local
   dependency under ISS-649's A->C isolation invariant. `OperatorWhoami` stays
   local: core declares that two-field answer inline in `admin/routes.ts` and
   there is no interface to lift. */

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

/** Discriminated result of the server-side gate check in `server/whoami.ts`.
 *  `redirect()` throws, so the RSC layout branches on this after the fetch
 *  returns rather than on a caught exception. */
export type OperatorWhoamiResult =
  | { kind: "admin"; email: string }
  | { kind: "not-admin" }
  | { kind: "unverified" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };
