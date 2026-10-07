import { MACHINE_ENTITIES } from '@forge/contracts/machines';
export const orgMemberRoles = ['owner', 'admin', 'member'] as const;

export type OrgMemberRole = (typeof orgMemberRoles)[number];

export const projectMemberRoles = ['admin', 'member', 'viewer'] as const;

export type ProjectMemberRole = (typeof projectMemberRoles)[number];

export const actorAgencies = ['human', 'agent'] as const;

export const memorySources = [
  'issue',
  'comment',
  'job',
  'note',
  'knowledge',
  'decision',
  'policy',
  // What memory's own upkeep did (a release's reconcile, a consolidation sweep): a record of a job,
  // never a decision. Core writes it; no caller may, and no search returns it unless asked by name.
  'bookkeeping',
] as const;

export type MemorySource = (typeof memorySources)[number];

/** The sources a caller may write or delete: every one but core's own bookkeeping. */
export const memoryWritableSources = memorySources.filter(
  (s): s is Exclude<MemorySource, 'bookkeeping'> => s !== 'bookkeeping',
);

export const conversationAdapters = ['web', 'widget', 'rocketchat', 'telegram'] as const;

export type ConversationAdapter = (typeof conversationAdapters)[number];

export const kernelTransitionEntities = MACHINE_ENTITIES;

export type KernelTransitionEntity = (typeof kernelTransitionEntities)[number];
