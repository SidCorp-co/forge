export type { ProjectPermission } from '@forge/contracts/permissions';
export { actorFor } from './actor.js';
export {
  type AgentCredentialFence,
  agentCredentialFence,
  agentCredentialGrant,
  regrantAgentCredentials,
  withAgentFenceLock,
} from './agent-fence.js';
export {
  can,
  heldPermissions,
  holdersOf,
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
export { holderNames, type NamedHolder, namedHolders } from './holders-named.js';
export {
  addOrgMember,
  addProjectMembers,
  removeOrgMember,
  removeProjectMember,
  updateOrgMember,
  updateProjectMember,
} from './memberships.js';
export { providePermissionsPorts } from './ports.js';
export { readsTechnical } from './project-lens.js';
export { resolveTurnAuthority } from './turn-authority.js';
