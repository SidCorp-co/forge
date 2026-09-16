/** The shapes an Epodsystem connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

// cm:guard the endpoint is NOT a config key here and must not become one — it is platform config read from `EPODSYSTEM_ENDPOINT`, so a field for it would let one project point the integration at another host (ISS-387)
// cm:guard every field is optional on input BECAUSE the healthcheck fills the store identity (slug, name, theme ids) — requiring any of them would make the operator transcribe what Forge is about to discover, and staging binds the draft theme against prod's main
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
