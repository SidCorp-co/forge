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
] as const;

export type MemorySource = (typeof memorySources)[number];

export const conversationAdapters = ['web', 'widget', 'rocketchat', 'telegram'] as const;

export type ConversationAdapter = (typeof conversationAdapters)[number];

export const kernelTransitionEntities = MACHINE_ENTITIES;

export type KernelTransitionEntity = (typeof kernelTransitionEntities)[number];
