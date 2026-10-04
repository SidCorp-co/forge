export type {
  ApprovalResource,
  OrgPermission,
  OrgResource,
  Permission,
  PermissionRefusal,
  PermissionResource,
  ProjectPermission,
  ProjectResource,
} from '@forge/contracts/permissions';
export { type Actor, actorFor } from './actor.js';
export {
  type AgentCredentialFence,
  agentCredentialFence,
  agentCredentialGrant,
  fenceFor,
  regrantAgentCredentials,
  withAgentFenceLock,
} from './agent-fence.js';
export {
  can,
  heldPermissions,
  holds,
  holdsOrg,
  orgResource,
  type PermissionActor,
  type PermissionFacts,
  permissionFactsOf,
  permissionRefusal,
  permissionRefusalFor,
  projectResource,
  requireCan,
  requireHeld,
  requireOrgCan,
  requireOrgHeld,
  visibleFilter,
} from './can.js';
export {
  addOrgMember,
  addProjectMembers,
  type NewOrgMembership,
  type NewProjectMembership,
  type OrgMembershipRow,
  type ProjectMembershipRow,
  removeOrgMember,
  removeProjectMember,
  removeProjectMembershipsOf,
  updateOrgMember,
  updateProjectMember,
} from './memberships.js';
export { resolveTurnAuthority } from './turn-authority.js';
