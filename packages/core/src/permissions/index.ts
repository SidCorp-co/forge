export type {
  ApprovalResource,
  OrgPermission,
  Permission,
  PermissionRefusal,
  PermissionScope,
  ProjectPermission,
} from '@forge/contracts/permissions';
export {
  can,
  heldPermissions,
  holds,
  holdsOrg,
  type PermissionActor,
  type PermissionFacts,
  permissionFactsOf,
  permissionRefusal,
  permissionRefusalFor,
  requireCan,
  requireHeld,
  requireOrgCan,
  requireOrgHeld,
} from './can.js';
