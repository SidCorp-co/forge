/**
 * ISS-1036 — the shapes a Google connection and binding are allowed to hold.
 *
 * They live beside the provider's auth, client and commands rather than in
 * `provider-schemas.ts` because the two tiers differ here, and the sentence a
 * caller gets for sending a binding key to the connection door is part of this
 * provider's interface, not the registry's.
 *
 * `provider-schemas.ts` still owns the dispatch: the two create-union arms and
 * the four per-provider lookup functions import from here.
 */

import { z } from 'zod';
import { releaseChannelFields } from '../release-channel-schema.js';
import { parseServiceAccountKey } from './auth.js';

// ISS-1036 — Google service account. The credential is the account's JSON key
// file, kept whole (see rotation.ts for why the file and not the PEM). Config
// is identity only: `clientEmail` and `projectId` are READ BACK OUT of the key
// by the healthcheck, mirroring epodsystem, so an operator transcribes nothing
// Forge is about to discover.
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
