/**
 * The `agent` release channel's declaration — the one provider with no adapter methods.
 *
 * Nothing is integrated here. It is a release CHANNEL declaration (which box may ship, how to prove
 * it shipped, how to undo it), and the deploy itself is the project's own script run by the release
 * session on a box that already holds the key. ISS-1071 gave it a declaration anyway, because the
 * registry is now the whole provider vocabulary: the create path has to resolve its schemas, the
 * status cards have to render it, and a provider missing from the registry is a provider half the
 * system does not know about.
 *
 * `adapter` is absent rather than stubbed. `getAdapter('agent')` answers `undefined`, which every
 * caller already guards — a stub throwing "not supported" would be a fourth live path that looks
 * like a provider Forge talks to.
 */

import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from './release-channel-schema.js';
import { declareIntegration } from './types.js';

const agentReleaseConfigSchema = z.object(releaseChannelFields);

// cm:guard NO secrets, ever. The whole point of this channel is that the production credential stays on the runner box: a deploy key in Forge would put every project's production behind one decryption path, which is the blast radius the release gate was designed to refuse.
const agentSecretsSchema = z.object({}).strict().default({});

export const agentIntegration = declareIntegration({
  provider: 'agent',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    canDeploy: true,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    agentPath: { kind: 'none' },
  },
  schemas: {
    connectionConfig: agentReleaseConfigSchema,
    bindingConfig: agentReleaseConfigSchema,
    patchConfig: agentReleaseConfigSchema.partial(),
    secrets: agentSecretsSchema,
    patchSecrets: agentSecretsSchema,
    primaryCredentialField: null,
    previousCredentialField: null,
    independentSecretFields: [],
    bindingConfigKeys: RELEASE_CHANNEL_KEYS,
  },
  usage: null,
  // cm:why null — a release channel is the project's own script run on a box that already holds the key, so there is no connection to report the health of and no card to draw.
  presentation: null,
});
