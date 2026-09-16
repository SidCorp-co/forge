// Cross-tenant Operator Ops Console wire shapes (ISS-649). Re-exported from
// core rather than restated: ISS-649's A->C invariant binds
// `features/operator/` to `@forge/contracts` + a thin api wrapper, and a
// second declaration of the same JSON is the drift that invariant exists to
// avoid.

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
