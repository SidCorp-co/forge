import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';
import { FOREIGN_TOKEN_URI_REFUSAL, parseServiceAccountKey } from './auth.js';

export const googleConfigBase = z.strictObject({
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

// Said of the key file a person pasted, never of the API field it rides in (ISS-1421 r28).
const SERVICE_ACCOUNT_SHAPE_REFUSAL =
  'This is not the whole service-account key file Google issued: that file is a JSON object with "type":"service_account", "client_email" and "private_key". Download it from the Google Cloud console under IAM & Admin → Service Accounts → Keys → Add key → JSON, and paste the file unchanged.';

const FOREIGN_TOKEN_URI_SAVE_REFUSAL =
  'This key file\'s "token_uri" is not Google\'s (https://oauth2.googleapis.com/token), so Forge will not send a signed assertion there. Re-download the key from the Google Cloud console and paste it unchanged.';

// The most a key file Google issues holds, said of the file and never as a count (ISS-1421 r29).
const KEY_FILE_MOST = 20000;

const OVERSIZED_KEY_FILE_REFUSAL =
  'This is larger than any service-account key file Google issues, so it holds more than the key file. Download the key again from the Google Cloud console under IAM & Admin → Service Accounts → Keys → Add key → JSON, and paste the file unchanged.';

export const googleSecretsSchema = z.strictObject({
  // No `.min`/`.max`: zod words those as a count of the field's characters, and a person pasting a
  // file counts nothing (judge-119 on 328). A short value fails the parse and is refused as no key file.
  serviceAccountJson: z.string().superRefine((value, ctx) => {
    if (value.length > KEY_FILE_MOST) {
      ctx.addIssue({ code: 'custom', message: OVERSIZED_KEY_FILE_REFUSAL });
      return;
    }
    try {
      parseServiceAccountKey(value);
    } catch (err) {
      // A whole key file naming another token endpoint is refused for that, not as no key file (ISS-1421 r27).
      const foreign = err instanceof Error && err.message === FOREIGN_TOKEN_URI_REFUSAL;
      ctx.addIssue({
        code: 'custom',
        message: foreign ? FOREIGN_TOKEN_URI_SAVE_REFUSAL : SERVICE_ACCOUNT_SHAPE_REFUSAL,
      });
    }
  }),
});

export const GOOGLE_BINDING_CONFIG_KEYS = [
  'defaultSpreadsheetId',
  ...RELEASE_CHANNEL_KEYS,
] as const;
