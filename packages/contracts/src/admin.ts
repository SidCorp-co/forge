// Cross-tenant Operator Ops Console wire shapes (ISS-649). Re-exported from
// core rather than restated: ISS-649's A->C invariant binds
// `features/operator/` to `@forge/contracts` + a thin api wrapper, and a
// second declaration of the same JSON is the drift that invariant exists to
// avoid.

// cm:edge contract -> packages/core/src/admin/types.ts — the declarations live there because `admin/aggregate-routes.ts` and `admin/alert-queries.ts` build these objects and core must not runtime-import contracts; this file is the browser's door to the same types, through core's `./admin-types` subpath rather than `./public`, which is already at the archmap fan-out limit
export type {
  AdminAdoptionBucket,
  AdminAlert,
  AdminAlertEntity,
  AdminAlertId,
  AdminAlertStatus,
  AdminGlanceMetric,
  AdminOverview,
  AdminWorkspaceRow,
} from '@forge/core/admin-types';
