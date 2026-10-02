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

export const autoflowSecretsSchema = z.object({
  accessToken: z.string().max(2000).startsWith('sat_', {
    error:
      'accessToken is the platform OAuth access token (sat_…) — the only credential the shop MCP /mcp door admits; a wmk_ API key or a srt_ refresh token is refused there',
  }),
});

export const AUTOFLOW_BINDING_CONFIG_KEYS = [...RELEASE_CHANNEL_KEYS, 'shop'] as const;
export const AUTOFLOW_BINDING_ONLY_CONFIG_KEYS = ['shop'] as const;
