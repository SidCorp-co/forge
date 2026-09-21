import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';
import { parseServiceAccountKey } from './auth.js';

export const googleConfigBase = z.object({
  clientEmail: z.string().min(1).max(320).optional(),
  projectId: z.string().min(1).max(200).optional(),
  defaultSpreadsheetId: z.string().min(1).max(200).optional(),
  ...releaseChannelFields,
});

export const GOOGLE_CONNECTION_TIER_KEYS = ['clientEmail', 'projectId'] as const;

export const googleConnectionConfigSchema = z
  .object({
    clientEmail: z.string().min(1).max(320).optional(),
    projectId: z.string().min(1).max(200).optional(),
  })
  .catchall(z.unknown())
  .superRefine((value, ctx) => {
    const offending = Object.keys(value as Record<string, unknown>).filter(
      (key) => !(GOOGLE_CONNECTION_TIER_KEYS as readonly string[]).includes(key),
    );
    if (offending.length === 0) return;
    ctx.addIssue({
      code: 'custom',
      message: `${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} the PROJECT's answer, not the credential's, so ${offending.length === 1 ? 'it belongs' : 'they belong'} on the binding — set via the project's own integration create, bind-existing, or binding PATCH. A Google connection holds the service-account key and the account identity read back out of it, and nothing else.`,
    });
  });

const SERVICE_ACCOUNT_SHAPE_REFUSAL =
  'serviceAccountJson must be the whole service-account key file Google issued — a JSON object with "type":"service_account", "client_email" and "private_key". Download it from the Google Cloud console under IAM & Admin → Service Accounts → Keys → Add key → JSON, and paste the file unchanged.';

export const googleSecretsSchema = z.object({
  serviceAccountJson: z
    .string()
    .min(100)
    .max(20000)
    .superRefine((value, ctx) => {
      try {
        parseServiceAccountKey(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: SERVICE_ACCOUNT_SHAPE_REFUSAL });
      }
    }),
});

export const GOOGLE_BINDING_CONFIG_KEYS = [
  'defaultSpreadsheetId',
  ...RELEASE_CHANNEL_KEYS,
] as const;
