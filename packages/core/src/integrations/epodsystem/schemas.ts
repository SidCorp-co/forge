/** The shapes an Epodsystem connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const epodsystemConfigBase = z.object({
  storeSlug: z.string().min(1).max(200).optional(),
  storeName: z.string().min(1).max(200).optional(),
  themeId: z.string().min(1).max(200).optional(),
  draftThemeId: z.string().min(1).max(200).optional(),
  commerceEnabled: z.boolean().optional(),
  ...releaseChannelFields,
});

export const epodsystemSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

export const EPODSYSTEM_BINDING_CONFIG_KEYS = RELEASE_CHANNEL_KEYS;
