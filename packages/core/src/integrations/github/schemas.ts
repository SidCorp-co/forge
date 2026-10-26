/** The shapes a GitHub connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

export const githubConfigBase = z.strictObject({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  contractCheck: z.boolean().optional(),
  ...releaseChannelFields,
});

// The App's private key, refused as a key and never by a count of the field's characters (ISS-1421 r29).
const PRIVATE_KEY_SHORTEST = 100;
const PRIVATE_KEY_LONGEST = 20000;

const PARTIAL_PRIVATE_KEY_REFUSAL =
  "This is not a whole GitHub App private key: GitHub gives it as a .pem file running from its BEGIN PRIVATE KEY line to its END PRIVATE KEY line. Generate one under the App's settings → Private keys, and paste the file unchanged.";

const OVERSIZED_PRIVATE_KEY_REFUSAL =
  "This is larger than any private key GitHub gives an App, so it holds more than the key. Paste the App's .pem file unchanged.";

const privateKeyField = z.string().superRefine((value, ctx) => {
  if (value.length < PRIVATE_KEY_SHORTEST) {
    ctx.addIssue({ code: 'custom', message: PARTIAL_PRIVATE_KEY_REFUSAL });
  } else if (value.length > PRIVATE_KEY_LONGEST) {
    ctx.addIssue({ code: 'custom', message: OVERSIZED_PRIVATE_KEY_REFUSAL });
  }
});

export const githubSecretsSchema = z.strictObject({
  appId: z.string().min(1).max(50),
  privateKey: privateKeyField,
  webhookSecret: z.string().min(8).max(500),
});

export const GITHUB_BINDING_CONFIG_KEYS = [
  'installationId',
  'owner',
  'repo',
  'contractCheck',
  ...RELEASE_CHANNEL_KEYS,
] as const;
