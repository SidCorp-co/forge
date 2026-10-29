import { supportRoomConfigSchema } from '@forge/contracts/support';
import { outsideRidsSchema } from '@forge/contracts/support-channel';
import { chatRoleSchema, operationsRoomConfigSchema } from '@forge/contracts/support-operations';
import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../index.js';

export const rocketchatConfigBase = z.object({
  serverUrl: z.string().url().max(500),
  rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  /** Present, the binding's one room is a support group answered by its session (REQ-75). */
  support: supportRoomConfigSchema.optional(),
  /** Present, each room the binding names is an operations room answered under the bot's role (REQ-75 BC-20). */
  operations: operationsRoomConfigSchema.optional(),
  /** Groups an agent outside Forge answers: Forge keeps each one's channel record only (REQ-75 r6). */
  outsideRids: outsideRidsSchema.optional(),
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
  'outsideRids',
  ...RELEASE_CHANNEL_KEYS,
] as const;
