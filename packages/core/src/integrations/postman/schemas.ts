/** The shapes a Postman connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

// cm:guard keep this base free of `.default()` — zod's `.partial()` still EMITS a field's default when the key is absent, so a default here turns a PATCH that names one field into one that silently resets region, mode and workspaceName. Defaults belong on the create schema alone (ISS-336).
export const postmanConfigBase = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  workspaceName: z.string().min(1).max(200),
  collectionId: z.string().min(1).max(200).optional(),
  region: z.enum(['us', 'eu']),
  mode: z.enum(['minimal', 'full']),
  ...releaseChannelFields,
});

export const postmanConfigSchema = postmanConfigBase.extend({
  workspaceName: postmanConfigBase.shape.workspaceName.default('Forge Integration'),
  region: postmanConfigBase.shape.region.default('us'),
  mode: postmanConfigBase.shape.mode.default('minimal'),
});

export const postmanSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

export const POSTMAN_BINDING_CONFIG_KEYS = RELEASE_CHANNEL_KEYS;
