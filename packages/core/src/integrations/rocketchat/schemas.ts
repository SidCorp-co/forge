import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const rocketchatConfigBase = z.object({
  serverUrl: z.string().url().max(500),
  rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  ...releaseChannelFields,
});

export const rocketchatSecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
  userId: z.string().min(1).max(200),
});

export const ROCKETCHAT_BINDING_CONFIG_KEYS = ['rids', ...RELEASE_CHANNEL_KEYS] as const;
