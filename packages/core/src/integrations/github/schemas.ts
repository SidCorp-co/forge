/** The shapes a GitHub connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const githubConfigBase = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  contractCheck: z.boolean().optional(),
  ...releaseChannelFields,
});

export const githubSecretsSchema = z.object({
  appId: z.string().min(1).max(50),
  privateKey: z.string().min(100).max(20000),
  webhookSecret: z.string().min(8).max(500),
});

export const GITHUB_BINDING_CONFIG_KEYS = [
  'installationId',
  'owner',
  'repo',
  'contractCheck',
  ...RELEASE_CHANNEL_KEYS,
] as const;
