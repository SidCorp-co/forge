/* Operator Ops Console module (ISS-650, filled in by ISS-653). Isolation
   invariant (A->C): only @forge/contracts, @/design, @/lib/*, @/providers/*,
   next, react and react-query are imported —
   no @/features/<other>. Consumers are app/admin/** and src/middleware.ts,
   which Next requires at that exact path and which therefore deep-imports
   server/operator-gate.ts. server/whoami.ts is deliberately NOT re-exported
   here (RSC-only, see its cm:guard) — app/admin/layout.tsx imports it by its
   deep path. */

export { OperatorShell } from "./components/operator-shell";
export { OperatorTopbar } from "./components/operator-topbar";
export { OperatorSection } from "./components/operator-section";
export { OperatorOverviewScreen } from "./components/overview-screen";
export { OperatorLoadError } from "./components/operator-load-error";
export { OPERATOR_SECTIONS, activeSectionFromPath, hrefForSection, type OperatorNavItem } from "./nav-model";
export { useOperatorWhoami } from "./hooks";
export { operatorApi } from "./api";
export type {
  OperatorSectionKey,
  OperatorWhoami,
  OperatorWhoamiResult,
  OperatorWindow,
  OperatorWorkspaceSort,
} from "./types";
