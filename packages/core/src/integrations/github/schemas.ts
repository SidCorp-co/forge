/** The shapes a GitHub connection and binding are allowed to hold (moved here by ISS-1071). */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../index.js';

export const githubConfigBase = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  ...releaseChannelFields,
});

/**
 * The connection-tier config of the instance's App: where its settings and install pages live,
 * read off GitHub when the App was made or completed, never typed.
 */
export const githubConnectionConfig = githubConfigBase.extend({
  appSlug: z.string().min(1).max(100).optional(),
  appOwner: z.string().min(1).max(100).optional(),
  appOwnerIsOrg: z.boolean().optional(),
});

export const githubSecretsSchema = z.object({
  appId: z.string().min(1).max(50),
  privateKey: z.string().min(100).max(20000),
  webhookSecret: z.string().min(8).max(500),
  // The App's OAuth pair, which proves an installation is the installer's own (`instance-app.ts`).
  clientId: z.string().min(1).max(100).optional(),
  clientSecret: z.string().min(8).max(500).optional(),
});

export const GITHUB_BINDING_CONFIG_KEYS = [
  'installationId',
  'owner',
  'repo',
  ...RELEASE_CHANNEL_KEYS,
] as const;
