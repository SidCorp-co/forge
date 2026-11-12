/**
 * A monitoring connection (ISS-1225, owner rulings 2026-11-12): a Prometheus that whoever runs it
 * connects to Forge. Forge bundles none. The connection names its URL, the basic-auth user Forge calls
 * it as, and how its backend takes rules (`ruler`); a connection holding no credentials is refused.
 * A project binds it with role `monitoring`, its target naming what to scrape and probe, the host
 * agent and its rules.
 *
 * Before a binding watching anything is taken, the server is read through its own status API and
 * each thing the binding needs that it does not do is refused by name (`readiness.ts`). Its rules
 * then reach the backend here, before the write is stored: `mimir` pushes the project's group to the
 * ruler, and a group the ruler refuses refuses the write; `file` is pulled from Forge by the
 * connection's host; `none` takes no rules. Nothing falls back.
 */

import {
  type MonitoringConfig,
  type MonitoringConnectionConfig,
  type MonitoringConnectionSecrets,
  monitoringConfigFaults,
  monitoringConfigSchema,
  monitoringConnectionConfigSchema,
  monitoringConnectionPatchSchema,
  monitoringConnectionPatchSecretsSchema,
  monitoringConnectionSecretsSchema,
} from '@forge/contracts/monitoring';
import { say } from '@forge/contracts/said';
import { stableStringify } from '../../lib/canonical-json.js';
import { logger } from '../../lib/logger.js';
import {
  type BindingTargetRefusal,
  declareIntegration,
  decryptConnectionSecrets,
  findConnectionById,
  forgeReads,
  type IntegrationAdapterMethods,
  type IntegrationConnectionRow,
  type VerifyBindingTargetArgs,
} from '../index.js';
import {
  connectionHealth,
  deleteRuleGroup,
  type MonitoringConnection,
  pushRuleGroup,
  readReadiness,
} from './client.js';
import { readinessFaults, watchesAnything } from './readiness.js';
import { renderRuleGroup, ruleGroupName } from './render.js';
import { recordReadiness } from './store.js';

type Config = MonitoringConnectionConfig & Partial<MonitoringConfig>;
type Secrets = MonitoringConnectionSecrets;

/** Every key of a monitoring binding's target: what one project watches. */
export const MONITORING_BINDING_CONFIG_KEYS = ['scrape', 'probe', 'agent', 'rules'] as const;

/** The connection a binding's target is verified against, read from its row. */
export function monitoringConnectionOf(connection: {
  config: unknown;
  secretsEnc: Buffer | null;
}): MonitoringConnection | null {
  // a dispatch hands the connection's config overlaid with the binding's: read the connection's half
  const held = { ...((connection.config ?? {}) as Record<string, unknown>) };
  for (const key of MONITORING_BINDING_CONFIG_KEYS) delete held[key];
  const config = monitoringConnectionConfigSchema.safeParse(held);
  if (!config.success) return null;
  return {
    config: config.data,
    secrets: decryptConnectionSecrets<Partial<Secrets>>(connection as IntegrationConnectionRow),
  };
}

/** Push or remove the project's rule group at a Mimir ruler; a refusal where it was not taken. */
async function syncRuler(
  conn: MonitoringConnection,
  slug: string,
  watched: MonitoringConfig,
): Promise<BindingTargetRefusal | null> {
  const group = renderRuleGroup(slug, watched);
  const refused = group
    ? await pushRuleGroup(conn, group)
    : await deleteRuleGroup(conn, ruleGroupName(slug));
  if (refused === null) return null;
  return {
    code: 'MONITORING_RULES_REFUSED',
    path: '/rules',
    detail: `the connection's ruler did not take this project's rules, so nothing was saved: ${refused}`,
  };
}

async function verifyMonitoringTarget(
  args: VerifyBindingTargetArgs,
): Promise<BindingTargetRefusal[]> {
  const parsed = monitoringConfigSchema.safeParse(args.config);
  if (!parsed.success) return [];
  const watched = parsed.data;
  const faults: BindingTargetRefusal[] = monitoringConfigFaults(watched);
  const conn = monitoringConnectionOf(args.connection);
  const rules = watched.rules ?? [];
  if (conn && conn.config.ruler === 'none' && rules.length > 0) {
    faults.push({
      code: 'MONITORING_BACKEND_TAKES_NO_RULES',
      path: '/rules',
      detail:
        "this binding's connection declares `ruler: none`: its backend takes no rules from Forge. Drop the rules, or bind a connection whose ruler is `mimir` (pushed) or `file` (pulled from Forge)",
    });
  }
  if (faults.length > 0 || !conn || !watchesAnything(watched)) return faults;
  const readiness = await readReadiness(conn, args.connection.id);
  await recordReadiness(args.connection.id, readiness);
  faults.push(...readinessFaults(readiness, watched, conn.config.ruler));
  if (faults.length > 0 || conn.config.ruler !== 'mimir') return faults;
  const before = (args.held as Partial<MonitoringConfig> | null)?.rules ?? [];
  if (stableStringify(before) === stableStringify(rules) && args.held !== null) return [];
  const slug = await forgeReads().projectSlug(args.projectId);
  if (!slug) return [];
  const refused = await syncRuler(conn, slug, watched);
  return refused ? [refused] : [];
}

/**
 * A connection holding no credentials is refused: Forge calls no monitoring server anonymously. A
 * `mimir` ruler naming no `rulerUrl` is refused too, since its config would then read as no
 * connection at all (`monitoringConnectionOf`).
 */
function verifyMonitoringConnection(args: {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}): BindingTargetRefusal[] {
  const config = args.config as Partial<MonitoringConnectionConfig>;
  // a PATCH is checked key by key, so the whole merged config is held to the create's rule here
  if (config.ruler === 'mimir' && config.rulerUrl === undefined) {
    return [
      {
        code: 'MONITORING_RULER_URL_MISSING',
        path: '/config/rulerUrl',
        detail:
          "ruler mimir pushes each project's rule group to a ruler API: name it in rulerUrl, or keep the ruler this connection had",
      },
    ];
  }
  const user = config.prometheusUser;
  const password = (args.secrets as Partial<Secrets>).prometheusPassword;
  if (user && password) return [];
  return [
    {
      code: 'MONITORING_SERVER_UNAUTHENTICATED',
      path: user ? '/secrets/prometheusPassword' : '/config/prometheusUser',
      detail:
        "a monitoring connection holds the basic-auth user (config.prometheusUser) and password (secrets.prometheusPassword) its server's web.yml admits, and Forge sends no project's data to an open endpoint",
    },
  ];
}

/** Read the server's readiness and record it; the connection's own read shows it. */
async function readAndRecord(connectionId: string): Promise<void> {
  const row = await findConnectionById(connectionId);
  const conn = row?.active ? monitoringConnectionOf(row) : null;
  if (!conn) return;
  await recordReadiness(connectionId, await readReadiness(conn, connectionId));
}

const methods: IntegrationAdapterMethods<Config, Secrets> = {
  verifyConnection: verifyMonitoringConnection,
  onConnectionChanged(connectionId) {
    readAndRecord(connectionId).catch((err: unknown) => {
      logger.warn({ err, connectionId }, 'monitoring: reading the server on save failed');
    });
  },
  verifyBindingTarget: verifyMonitoringTarget,

  async healthcheck(ctx) {
    const conn = monitoringConnectionOf({ config: ctx.config, secretsEnc: null });
    if (!conn) {
      return { status: 'error', message: "this connection's config is no monitoring connection's" };
    }
    const refused = await connectionHealth({ config: conn.config, secrets: ctx.secrets });
    return refused === null
      ? { status: 'ok', diagnostics: { ruler: conn.config.ruler } }
      : { status: 'error', message: refused };
  },

  handleInbound: () => {
    throw new Error(
      'prometheus: alerts arrive at POST /api/monitoring/connections/:id/alerts, never on a binding webhook',
    );
  },
};

/** The monitoring connection's declaration: bound with role `monitoring` alone, one per project. */
export const prometheusIntegration = declareIntegration<Config, Secrets>({
  provider: 'prometheus',
  capabilities: {
    onlyRole: 'monitoring',
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
    connectionConfig: monitoringConnectionConfigSchema,
    connectionPatchConfig: monitoringConnectionPatchSchema,
    bindingConfig: monitoringConfigSchema,
    patchConfig: monitoringConfigSchema.partial(),
    secrets: monitoringConnectionSecretsSchema,
    patchSecrets: monitoringConnectionPatchSecretsSchema,
    primaryCredentialField: 'prometheusPassword',
    previousCredentialField: null,
    independentSecretFields: [],
    bindingConfigKeys: MONITORING_BINDING_CONFIG_KEYS,
    bindingOnlyConfigKeys: MONITORING_BINDING_CONFIG_KEYS,
  },
  usage: null,
  presentation: {
    label: 'Prometheus monitoring',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverTested'),
    cardMeta: (config) => {
      const cfg = config as Partial<MonitoringConnectionConfig>;
      return { prometheusUrl: cfg.prometheusUrl ?? null, ruler: cfg.ruler ?? null };
    },
  },
  adapter: methods,
});
