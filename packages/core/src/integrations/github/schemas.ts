/** The shapes a GitHub connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const githubConfigBase = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  ...releaseChannelFields,
});

// cm:guard every field here is WRITTEN BY GitHub, never typed by an operator — the app-manifest conversion returns `id`, `pem` and `webhook_secret` together, so a connection carrying some of them is a half-finished authorization, not a mis-typed form. `webhookSecret` belongs to the App and is copied onto each binding's `integrationSecret`; that is why the adapter must match the repository itself rather than letting the signature pick the binding.
export const githubSecretsSchema = z.object({
  appId: z.string().min(1).max(50),
  privateKey: z.string().min(100).max(20000),
  webhookSecret: z.string().min(8).max(500),
});

// cm:guard `installationId` is binding-tier with owner/repo, not connection-tier — ONE App can hold several installations, and splitProviderConfig drops from the binding every key missing here, so leaving it out lets a bind succeed with the repository recorded and no way to mint a token for it (adapter.ts reads all three together)
export const GITHUB_BINDING_CONFIG_KEYS = [
  'installationId',
  'owner',
  'repo',
  ...RELEASE_CHANNEL_KEYS,
] as const;
