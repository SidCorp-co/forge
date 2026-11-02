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
export {
  type DeclaredPermission,
  declaredPermissions,
  enforceDeclared,
  onArg,
  onResolved,
  type PermissionlessAccess,
  type PermissionOn,
  permissionless,
  requireDeclared,
  requireDeclaredOn,
  requireDeclaredOr,
  requireDeclaredOrg,
  requiresNoPermission,
  requiresOnParam,
  requiresOnResolved,
  requiresPublic,
  requiresSelf,
  runDeclaredTool,
  type ToolPermission,
  toolPermissionFor,
} from './declared.js';
export { holderNames, type NamedHolder, namedHolders } from './holders-named.js';
export {
  actsAsMaster,
  isMasterCredential,
  MASTER_GRANTS,
  type MasterAsk,
  masterActRefusal,
  masterFacts,
  masterFactsOf,
  requireMasterAct,
} from './master-acts.js';
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
