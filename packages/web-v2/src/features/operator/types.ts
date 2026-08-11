/* Operator Ops Console — foundation types. Local mirror of the core
   `/api/admin/whoami` response; nothing in @forge/contracts yet (ISS-650). */

export type OperatorSectionKey =
  | "overview"
  | "alerts"
  | "fleet"
  | "pipeline"
  | "growth"
  | "mcp-logs";

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
