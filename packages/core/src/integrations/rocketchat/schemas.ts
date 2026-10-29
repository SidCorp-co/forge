import { rocketchatBindingTargetShape } from '@forge/contracts/support-channel';
import { chatRoleSchema } from '@forge/contracts/support-operations';
import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../index.js';

export const rocketchatConfigBase = z.object({
  serverUrl: z.string().url().max(500),
  // the groups the binding names and who answers them (REQ-75, REQ-77)
  ...rocketchatBindingTargetShape,
  /** The bot account's one role (BC-22): kept on the connection, which is the account. */
  role: chatRoleSchema.optional(),
  ...releaseChannelFields,
});

export const rocketchatSecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
  userId: z.string().min(1).max(200),
});

export const ROCKETCHAT_BINDING_CONFIG_KEYS = [
  'rids',
  'support',
  'operations',
  'agent',
  'outsideRids',
  ...RELEASE_CHANNEL_KEYS,
] as const;
