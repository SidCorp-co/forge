/** The shapes an Autoflow connection and binding are allowed to hold. */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../release-channel-schema.js';

const httpsUrl = () =>
  z
    .url({ protocol: /^https$/, error: 'must be an https:// URL' })
    .max(500)
    .optional();

/** A site slug as the platform mints it: the `<shop>` label of `<shop>.auto.sidcorp.co`. */
export const autoflowShop = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, {
  error:
    'shop is the site slug — the <shop> of <shop>.auto.sidcorp.co: lowercase letters, digits and dashes, at most 63',
});

const connectionFields = {
  baseUrl: httpsUrl(),
  mcpUrl: httpsUrl(),
  ...releaseChannelFields,
};

export const autoflowConnectionConfig = z.object(connectionFields);

/** A binding names the site it builds; one without it has nothing to point the token at. */
export const autoflowBindingConfig = z.object({ ...connectionFields, shop: autoflowShop });

const secretFields = {
  accessToken: z.string().max(2000).startsWith('sat_', {
    error:
      'accessToken is the platform OAuth access token (sat_…) — the only credential the shop MCP /mcp door admits; a wmk_ API key or a srt_ refresh token is refused there',
  }),
  accessTokenExpiresAt: z.iso.datetime({
    offset: true,
    error:
      'accessTokenExpiresAt is the ISO-8601 instant the access token expires (now + expires_in)',
  }),
  refreshToken: z.string().max(2000).startsWith('srt_', {
    error:
      'refreshToken is the platform OAuth refresh token (srt_…) issued beside the access token by /oauth/token',
  }),
  clientId: z.string().max(200).startsWith('mcpc_', {
    error:
      'clientId is the OAuth client (mcpc_…) the token pair was issued to — the platform refuses a refresh without it',
  }),
};

const REFRESH_NEEDS_CLIENT =
  'refreshToken and clientId travel together: the platform refuses a refresh_token grant that names no client_id, so a refresh token stored without one could never be redeemed';

const pairedRefresh = (s: { refreshToken?: string | undefined; clientId?: string | undefined }) =>
  (s.refreshToken === undefined) === (s.clientId === undefined);

export const autoflowSecretsSchema = z
  .object({
    accessToken: secretFields.accessToken,
    accessTokenExpiresAt: secretFields.accessTokenExpiresAt.optional(),
    refreshToken: secretFields.refreshToken.optional(),
    clientId: secretFields.clientId.optional(),
  })
  .refine(pairedRefresh, { error: REFRESH_NEEDS_CLIENT, path: ['refreshToken'] });

/** A PATCH may store a refresh token without re-sending the access token, but never half a pair. */
export const autoflowPatchSecretsSchema = z
  .object({
    accessToken: secretFields.accessToken.optional(),
    accessTokenExpiresAt: secretFields.accessTokenExpiresAt.optional(),
    refreshToken: secretFields.refreshToken.optional(),
    clientId: secretFields.clientId.optional(),
  })
  .refine(pairedRefresh, { error: REFRESH_NEEDS_CLIENT, path: ['refreshToken'] });

/** Written beside the access token or on their own; a rotation must not drop them. */
export const AUTOFLOW_INDEPENDENT_SECRET_FIELDS = [
  'accessTokenExpiresAt',
  'refreshToken',
  'clientId',
] as const;

export const AUTOFLOW_BINDING_CONFIG_KEYS = [...RELEASE_CHANNEL_KEYS, 'shop'] as const;
export const AUTOFLOW_BINDING_ONLY_CONFIG_KEYS = ['shop'] as const;
