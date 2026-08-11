/* Operator Ops Console module (ISS-650). Isolation invariant (A->C): only
   @/design, @/lib/*, @/providers/*, next, react, react-query are imported —
   no @/features/<other>. server/whoami.ts is deliberately NOT re-exported
   here (RSC-only, see its cm:guard) — app/admin/layout.tsx imports it by its
   deep path. */

export { OperatorShell } from "./components/operator-shell";
export { OperatorTopbar } from "./components/operator-topbar";
export { OperatorSection } from "./components/operator-section";
export { OperatorLoadError } from "./components/operator-load-error";
export { OPERATOR_SECTIONS, activeSectionFromPath, hrefForSection, type OperatorNavItem } from "./nav-model";
export { useOperatorWhoami } from "./hooks";
export { operatorApi } from "./api";
export type { OperatorSectionKey, OperatorWhoami, OperatorWhoamiResult } from "./types";
