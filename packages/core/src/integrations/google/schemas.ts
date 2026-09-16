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
  // cm:edge contract -> packages/core/src/integrations/google/commands.ts — the per-project sheet. It MUST stay listed in BINDING_CONFIG_KEYS below: a binding-tier key the provider does not declare there is stripped on PATCH (zod objects drop unknown keys) and the setting then reads as never-saved.
  defaultSpreadsheetId: z.string().min(1).max(200).optional(),
  ...releaseChannelFields,
});

// cm:guard the owner-scoped connection routes take THIS schema and not `googleConfigBase`: a connection is the shared credential, and `defaultSpreadsheetId` on it would be inherited by every project bound to it that declares none. The refusal is by name because the key is legal — on the binding — and a caller who sent it to the wrong tier needs to be told which one is right (ISS-1036).
// cm:edge contract -> packages/core/src/integrations/connection-routes.ts — both the create and the PATCH on that router must reach this, or the tier is enforced on one door and not the other.
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

// cm:edge contract -> packages/core/src/integrations/google/auth.ts — what counts as a service-account key file is decided by `parseServiceAccountKey` and nowhere else. Restating the field checks here would let the create form accept a file the mint then refuses, which is the create-time validation and the run-time validation disagreeing about the same bytes.
// cm:guard the file is validated for SHAPE and never reshaped — Forge stores the bytes Google issued, so a key carrying a field Forge did not think to model still signs correctly. Parsing it into named columns is how a future Google field goes missing in silence.
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
