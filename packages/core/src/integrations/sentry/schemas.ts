/**
 * The shapes a Sentry connection and binding are allowed to hold (ISS-524 / ISS-526, moved here by
 * ISS-1071).
 *
 * Config is the non-secret target set (Sentry host plus a labelled `targets[]` list of org/project
 * bindings); the `sntryu_` auth token is the only secret. `sentryConfigBase` carries NO defaults so
 * `.partial()` is a true partial for PATCH. The host is required on create — it is the MCP server's
 * `SENTRY_HOST`. The legacy top-level slugs stay optional for back-compat reads; new writes use
 * `targets[]`.
 */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

const sentryTargetSchema = z.object({
  label: z.string().min(1).max(120),
  organizationSlug: z.string().min(1).max(200).optional(),
  projectSlug: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export const sentryConfigBase = z.object({
  host: z.string().min(1).max(255),
  targets: z.array(sentryTargetSchema).max(50).optional(),
  organizationSlug: z.string().min(1).max(200).optional(),
  projectSlug: z.string().min(1).max(200).optional(),
  ...releaseChannelFields,
});

export const sentrySecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
});

export const SENTRY_BINDING_CONFIG_KEYS = RELEASE_CHANNEL_KEYS;
