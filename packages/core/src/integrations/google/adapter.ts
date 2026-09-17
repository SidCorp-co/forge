/**
 * ISS-1036 — Google service-account adapter.
 *
 * Google's role in Forge is server-side Sheets access for a project's agents:
 * `mcp/tools/forge-google-sheets.ts` resolves the binding, core makes the call,
 * and the JSON key never leaves this process. So this adapter implements
 * `healthcheck` alone — there is no outbound delivery and no inbound webhook,
 * the same archetype `sentry/adapter.ts` has.
 */

import { logger } from '../../logger.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { findConnectionById, updateConnection } from '../store.js';
import {
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import { googleAccessToken, parseServiceAccountKey } from './auth.js';
import { getSpreadsheet } from './client.js';
import {
  GOOGLE_BINDING_CONFIG_KEYS,
  googleConfigBase,
  googleConnectionConfigSchema,
  googleSecretsSchema,
} from './schemas.js';
import { SHEETS_READONLY_SCOPE } from './scopes.js';
import { GoogleApiError, GoogleAuthError, type GoogleConfig, type GoogleSecrets } from './types.js';

const notSupported = (op: string): never => {
  throw new Error(
    `google: ${op} is not supported — this provider has no delivery surface. Agents reach Sheets through the forge_google_sheets tool, which calls Google from core.`,
  );
};

/** Which credential the mint succeeded with, so the caller knows whether the
 *  rotation window carried it. */
interface MintOutcome {
  token: string;
  usedPrevious: boolean;
}

/**
 * Mint with the stored key, falling back once to a retained previous key that
 * is still inside the ISS-405 overlap window. `forceMint` throughout: this is
 * test-connection, and a cached token would report on a credential the operator
 * may already have replaced.
 */
async function mintForHealthcheck(
  connectionId: string,
  secrets: GoogleSecrets,
): Promise<MintOutcome> {
  const primary = secrets.serviceAccountJson as string;
  try {
    const { token } = await googleAccessToken({
      connectionId,
      serviceAccountJson: primary,
      scope: SHEETS_READONLY_SCOPE,
      forceMint: true,
    });
    return { token, usedPrevious: false };
  } catch (err) {
    const recoverable =
      err instanceof GoogleAuthError &&
      err.kind === 'rejected' &&
      typeof secrets.previousServiceAccountJson === 'string' &&
      isPreviousCredentialValid(secrets);
    if (!recoverable) throw err;
    const { token } = await googleAccessToken({
      connectionId,
      serviceAccountJson: secrets.previousServiceAccountJson as string,
      scope: SHEETS_READONLY_SCOPE,
      forceMint: true,
    });
    return { token, usedPrevious: true };
  }
}

/** Identity read back out of the key so the card and the directory can name the
 *  account without the operator transcribing it. Never the key itself. */
function identityFrom(serviceAccountJson: string): { clientEmail: string; projectId?: string } {
  const key = parseServiceAccountKey(serviceAccountJson);
  return {
    clientEmail: key.client_email,
    ...(key.project_id ? { projectId: key.project_id } : {}),
  };
}

/**
 * The connection config to persist: the CONNECTION's own stored config with the
 * identity merged in.
 *
 * cm:guard never build this from `ctx.config`. That is `effectiveConfig` —
 * connection overlaid with binding — so writing it back promotes this project's
 * binding-tier keys onto the shared credential, and `defaultSpreadsheetId` is
 * exactly such a key. One org account bound to two projects would then have
 * whichever project was health-checked last decide the fallback sheet for the
 * other, which is the `wholesale-config-clobber` red flag reached by a write
 * rather than a PATCH (ISS-1036).
 */
async function connectionConfigWithIdentity(
  connectionId: string,
  identity: { clientEmail: string; projectId?: string },
): Promise<Record<string, unknown>> {
  const connection = await findConnectionById(connectionId);
  return { ...((connection?.config ?? {}) as Record<string, unknown>), ...identity };
}

async function failHealth(
  connectionId: string,
  status: 'error' | 'needs_reauth' | 'needs_scope',
  message: string,
  diagnostics?: Record<string, unknown>,
): Promise<HealthCheckResult> {
  await updateConnection(connectionId, { lastHealthStatus: status, lastHealthAt: new Date() });
  return { status, message, ...(diagnostics ? { diagnostics } : {}) };
}

const googleAdapterMethods: IntegrationAdapterMethods<GoogleConfig, GoogleSecrets> = {
  async healthcheck(ctx): Promise<HealthCheckResult> {
    const serviceAccountJson = ctx.secrets?.serviceAccountJson;
    if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length === 0) {
      return failHealth(ctx.connectionId, 'error', 'no Google service-account key is stored');
    }

    let mint: MintOutcome;
    try {
      mint = await mintForHealthcheck(ctx.connectionId, ctx.secrets);
    } catch (err) {
      if (err instanceof GoogleAuthError && err.kind === 'rejected') {
        return failHealth(ctx.connectionId, 'needs_reauth', err.message, {
          httpStatus: err.status,
        });
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
        'google: minting an access token failed',
      );
      return failHealth(ctx.connectionId, 'error', message);
    }

    const identity = identityFrom(serviceAccountJson);
    const spreadsheetId = ctx.config?.defaultSpreadsheetId;
    // cm:guard a valid credential with nothing to read is `degraded`, never `ok` — "the account authenticates" is a weaker claim than this card makes anywhere else, and reporting it green is how a binding that can reach no sheet passes test-connection and fails at the first job (ISS-1036)
    if (typeof spreadsheetId !== 'string' || spreadsheetId.length === 0) {
      await updateConnection(ctx.connectionId, {
        config: await connectionConfigWithIdentity(ctx.connectionId, identity),
        lastHealthStatus: 'degraded',
        lastHealthAt: new Date(),
      });
      return {
        status: 'degraded',
        message: `Google accepted ${identity.clientEmail}, but this project declares no default spreadsheet, so nothing was read. Set one on the binding to prove the account can reach it.`,
        diagnostics: { ...identity, usedPreviousCredential: mint.usedPrevious },
      };
    }

    try {
      const sheet = await getSpreadsheet(
        {
          connectionId: ctx.connectionId,
          serviceAccountJson: mint.usedPrevious
            ? (ctx.secrets.previousServiceAccountJson as string)
            : serviceAccountJson,
        },
        spreadsheetId,
      );
      await updateConnection(ctx.connectionId, {
        config: await connectionConfigWithIdentity(ctx.connectionId, identity),
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: `Read "${sheet.title ?? spreadsheetId}" as ${identity.clientEmail}`,
        diagnostics: {
          ...identity,
          spreadsheetId,
          title: sheet.title,
          sheetTitles: sheet.sheetTitles,
          usedPreviousCredential: mint.usedPrevious,
        },
      };
    } catch (err) {
      if (err instanceof GoogleApiError) {
        const status =
          err.status === 403 ? 'needs_scope' : err.status === 401 ? 'needs_reauth' : 'error';
        return failHealth(ctx.connectionId, status, err.message, {
          httpStatus: err.status,
          spreadsheetId,
        });
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
        'google: healthcheck failed',
      );
      return failHealth(ctx.connectionId, 'error', message);
    }
  },

  async handleInbound() {
    return notSupported('handleInbound');
  },
};

/**
 * Google's declaration. `core-mediated`: core holds the service-account key and makes every Sheets
 * call itself, so the grant widens who may ask core rather than who holds the credential — there is
 * no key for an agent to fetch and none reaches a runner.
 */
export const googleIntegration = declareIntegration<GoogleConfig, GoogleSecrets>({
  provider: 'google',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    structuredRollback: false,
    agentPath: { kind: 'core-mediated', tools: ['forge_google_sheets'] },
  },
  schemas: {
    connectionConfig: googleConnectionConfigSchema,
    bindingConfig: googleConfigBase,
    patchConfig: googleConfigBase.partial(),
    secrets: googleSecretsSchema,
    patchSecrets: googleSecretsSchema.partial(),
    primaryCredentialField: 'serviceAccountJson',
    // cm:why the whole service-account JSON is the rotating unit, not the PEM inside it — Google reissues a key as a new file whose `private_key_id` and `client_email` travel with the PEM, and rotating the PEM alone would leave the connection signing with a key id Google no longer maps to it
    previousCredentialField: 'previousServiceAccountJson',
    independentSecretFields: [],
    bindingConfigKeys: GOOGLE_BINDING_CONFIG_KEYS,
  },
  usage: {
    hint: "Read and write the project's bound Google Sheets via the `forge_google_sheets` tool. Core holds the service-account key — there is none to fetch, and a sheet is reachable only once it is shared with the account.",
    guideSlug: 'google-sheets',
  },
  presentation: {
    label: 'Google Sheets',
    alwaysStageKeyed: false,
    neverCheckedDetail: 'never test-connected',
    cardMeta: (config) => {
      const cfg = config as { clientEmail?: string; defaultSpreadsheetId?: string };
      return {
        clientEmail: cfg.clientEmail ?? null,
        defaultSpreadsheetId: cfg.defaultSpreadsheetId ?? null,
      };
    },
  },
  adapter: googleAdapterMethods,
});

export const googleAdapter = googleAdapterMethods;
