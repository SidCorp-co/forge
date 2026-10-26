/**
 * The product API a project grants its Rocket.Chat support session (REQ-75): the connection holds
 * the base URL, the hosts it grants beside it and the scoped credential (header values, sealed in
 * the vault); the binding declares the tools — `diagnose` (reads, runs at once) and `fix` (runs
 * only after the asker confirms). Nothing is dispatched to it and nothing arrives from it: the
 * support module calls it through `call.ts`, the one door a tool's request leaves by.
 */

import { say } from '@forge/contracts/said';
import {
  supportApiBindingConfigSchema,
  supportApiConnectionConfigSchema,
  supportApiSecretsSchema,
} from '@forge/contracts/support';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../index.js';

type SupportApiConfig = Record<string, unknown>;
type SupportApiSecrets = Record<string, unknown>;

/** The tools live on the binding: one connection (one API) may serve several projects' rooms. */
export const SUPPORT_API_BINDING_CONFIG_KEYS = ['tools'] as const;

const supportApiAdapterMethods: IntegrationAdapterMethods<SupportApiConfig, SupportApiSecrets> = {
  // the API is a project's own product, reached only by a declared tool a person asked for; a
  // health probe would be a call nobody asked for, so health is the configuration the door can use
  async healthcheck(
    ctx: AdapterContext<SupportApiConfig, SupportApiSecrets>,
  ): Promise<HealthCheckResult> {
    const faults: string[] = [];
    const config = supportApiConnectionConfigSchema.safeParse({
      baseUrl: ctx.config.baseUrl,
      ...(ctx.config.hosts ? { hosts: ctx.config.hosts } : {}),
    });
    if (!config.success)
      faults.push(...config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const tools = supportApiBindingConfigSchema.safeParse({ tools: ctx.config.tools });
    if (ctx.bindingId && !tools.success) {
      faults.push(...tools.error.issues.map((i) => `tools.${i.path.join('.')}: ${i.message}`));
    }
    const secrets = supportApiSecretsSchema.safeParse(ctx.secrets);
    if (!secrets.success)
      faults.push('secrets.headers: the credential headers are missing or malformed');
    if (faults.length > 0) {
      return {
        status: 'error',
        message: `this support API cannot be called as configured: ${faults.join('; ')}`,
      };
    }
    return {
      status: 'ok',
      diagnostics: {
        baseUrl: config.data?.baseUrl,
        hosts: config.data?.hosts ?? [],
        tools: tools.success ? tools.data.tools.map((t) => `${t.kind}:${t.name}`) : [],
        headerNames: Object.keys(secrets.data?.headers ?? {}),
      },
    };
  },

  handleInbound: () => {
    throw new Error('support-api: nothing arrives from a support API; the support module calls it');
  },
};

/**
 * No agent path: the support session reaches the API only through `forge_support`, which runs a
 * declared tool here. `multiBinding` is off: a project grants its session one API.
 */
export const supportApiIntegration = declareIntegration<SupportApiConfig, SupportApiSecrets>({
  provider: 'support-api',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    structuredRollback: false,
    agentPath: { kind: 'none' },
  },
  schemas: {
    connectionConfig: supportApiConnectionConfigSchema,
    connectionPatchConfig: supportApiConnectionConfigSchema.partial(),
    bindingConfig: supportApiBindingConfigSchema,
    patchConfig: supportApiBindingConfigSchema.partial(),
    secrets: supportApiSecretsSchema,
    patchSecrets: supportApiSecretsSchema.partial(),
    primaryCredentialField: null,
    previousCredentialField: null,
    independentSecretFields: ['headers'],
    bindingConfigKeys: SUPPORT_API_BINDING_CONFIG_KEYS,
    bindingOnlyConfigKeys: SUPPORT_API_BINDING_CONFIG_KEYS,
  },
  usage: null,
  presentation: {
    label: 'Support API',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverTested'),
    cardMeta: (config) => {
      const cfg = config as { baseUrl?: string; tools?: unknown[] };
      return {
        baseUrl: cfg.baseUrl ?? null,
        tools: Array.isArray(cfg.tools) ? cfg.tools.length : 0,
      };
    },
  },
  adapter: supportApiAdapterMethods,
});
