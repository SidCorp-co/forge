/**
 * The feedback widget: a chat a client site embeds so its own end users reach a project's limited
 * assistant (`packages/contracts/src/widget.ts`). Nothing is dispatched to a vendor and nothing
 * arrives on a webhook: the site key a binding holds names it on the widget's public routes, and the
 * binding's own secret (`integration_bindings.integration_secret_enc`, minted on bind like every
 * binding's) is what a client backend signs a visitor's identity with. The connection holds nothing.
 */

import { say } from '@forge/contracts/said';
import { widgetBindingConfigSchema } from '@forge/contracts/widget';
import { z } from 'zod';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../index.js';
import { settleSiteKey } from './site-key.js';

type WidgetConfig = Record<string, unknown>;
type WidgetSecrets = Record<string, never>;

const connectionConfigSchema = z.object({}).strict().default({});
const secretsSchema = z.object({}).strict().default({});

/** Every key of a widget's config lives on its binding: one connection serves every site. */
export const WIDGET_BINDING_CONFIG_KEYS = [
  'siteKey',
  'allowedOrigins',
  'identity',
  'title',
  'greeting',
  'accent',
  'limits',
] as const;

const widgetAdapterMethods: IntegrationAdapterMethods<WidgetConfig, WidgetSecrets> = {
  settleBindingConfig: settleSiteKey,

  // there is no vendor to reach: a binding is healthy when the config it holds is one the public
  // routes can serve and it holds the secret a signed identity is checked against
  async healthcheck(ctx: AdapterContext<WidgetConfig, WidgetSecrets>): Promise<HealthCheckResult> {
    const parsed = widgetBindingConfigSchema.safeParse(ctx.config);
    if (!parsed.success) {
      return {
        status: 'error',
        message: `this widget binding's config is not one the widget can serve: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')}`,
      };
    }
    return {
      status: 'ok',
      diagnostics: {
        siteKey: parsed.data.siteKey,
        allowedOrigins: parsed.data.allowedOrigins,
        identity: parsed.data.identity.mode,
        signingSecretSet: ctx.integrationSecret !== null,
      },
    };
  },

  handleInbound: () => {
    throw new Error(
      'widget: nothing arrives on a webhook; a visitor reaches the widget through /api/widget',
    );
  },
};

/**
 * The widget's declaration. No agent path: its assistant reads nothing of the project and an agent
 * has nothing to call here. `multiBinding`: a project embeds the widget on several sites, one
 * labelled binding each.
 */
export const widgetIntegration = declareIntegration<WidgetConfig, WidgetSecrets>({
  provider: 'widget',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: true,
    structuredRollback: false,
    agentPath: { kind: 'none' },
  },
  schemas: {
    connectionConfig: connectionConfigSchema,
    connectionPatchConfig: connectionConfigSchema,
    bindingConfig: widgetBindingConfigSchema,
    patchConfig: widgetBindingConfigSchema.partial(),
    secrets: secretsSchema,
    patchSecrets: secretsSchema,
    primaryCredentialField: null,
    previousCredentialField: null,
    independentSecretFields: [],
    bindingConfigKeys: WIDGET_BINDING_CONFIG_KEYS,
    bindingOnlyConfigKeys: WIDGET_BINDING_CONFIG_KEYS,
  },
  usage: null,
  presentation: {
    label: 'Feedback widget',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverTested'),
    cardMeta: (config) => {
      const cfg = config as { siteKey?: string; allowedOrigins?: string[] };
      return { siteKey: cfg.siteKey ?? null, allowedOrigins: cfg.allowedOrigins ?? null };
    },
  },
  adapter: widgetAdapterMethods,
});
