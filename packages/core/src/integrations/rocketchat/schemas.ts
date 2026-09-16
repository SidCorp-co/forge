/**
 * The shapes a Rocket.Chat connection and binding are allowed to hold (ISS-609, moved here by
 * ISS-1071).
 *
 * Connection-tier config is the server URL; the room ids (`rids`) are BINDING-tier so one org bot
 * credential serves N project channels and one project can listen on several rooms — the same
 * pattern as coolify's `targets[]`; migration 0146 rewrote legacy single-`rid` rows. Secrets are
 * the bot PAT (X-Auth-Token / DDP resume) plus its user id.
 */

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
