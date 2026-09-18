/** The shapes a GitHub connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const githubConfigBase = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  // cm:guard ABSENT means on, and that is the whole of the default. ISS-1072 publishes `forge/issue-contract` on every bound repository; reading an absent key as off would ship a feature that runs nowhere, and nobody finds that out until someone asks why no check ever appeared.
  contractCheck: z.boolean().optional(),
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
  // cm:guard binding-tier, with the repository it is about. One App serves many installations and many repositories, so a connection-tier switch would turn the check off for every repository an operator wanted it off for one of — and `splitProviderConfig` drops from the binding every key missing from this list, so leaving it out makes the switch silently unsettable.
  'contractCheck',
  ...RELEASE_CHANNEL_KEYS,
] as const;
