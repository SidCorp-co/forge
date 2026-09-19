import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from './release-channel-schema.js';
import { declareIntegration } from './types.js';

const agentReleaseConfigSchema = z.object(releaseChannelFields);

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
    structuredRollback: false,
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
  presentation: null,
});
