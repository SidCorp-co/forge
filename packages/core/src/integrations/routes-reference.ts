import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { zValidator } from '../api-reference/declare/validator.js';
import {
  bindingRoles,
  deployStages,
  integrationDeliveries,
  integrationOwnerTypes,
} from '../db/schema.js';
import { AGENT_ACCESS_VALUES } from './agent-access.js';
import { UNREADABLE_WHEN } from './credential-unreadable.js';
import { badRequest } from './route-helpers.js';
import { INTEGRATION_PROVIDERS } from './types.js';

/** The refusal every integration route gives a path value that is not a uuid. */
const refuseInvalid = (result: { success: boolean; error?: z.core.$ZodError }): void => {
  if (!result.success && result.error) throw badRequest(z.flattenError(result.error));
};

export const projectParamSchema = z.object({ projectId: z.uuid() });
export const bindingParamSchema = z.object({ projectId: z.uuid(), id: z.uuid() });
export const deliveryParamSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid(),
  deliveryId: z.uuid(),
});
export const connectionParamSchema = z.object({ id: z.uuid() });

export const inProject = zValidator('param', projectParamSchema, refuseInvalid);
export const inBinding = zValidator('param', bindingParamSchema, refuseInvalid);
export const inDelivery = zValidator('param', deliveryParamSchema, refuseInvalid);
export const inConnection = zValidator('param', connectionParamSchema, refuseInvalid);

/** The path check and the descriptor a route puts before its handler, as one list to spread. */
export const onProject = (op: MiddlewareHandler) => [op, inProject] as const;
export const onBinding = (op: MiddlewareHandler) => [op, inBinding] as const;
export const onDelivery = (op: MiddlewareHandler) => [op, inDelivery] as const;

export const okSchema = z.object({ ok: z.literal(true) });

const providerSchema = z.enum(INTEGRATION_PROVIDERS);
const configSchema = z.record(z.string(), z.unknown());

/** What a binding looks like to a person: the credential's health beside where it is used. */
export const bindingSummarySchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  projectId: z.string(),
  provider: providerSchema,
  role: z.enum(bindingRoles),
  stages: z.array(z.enum(deployStages)),
  config: configSchema,
  bindingConfig: configSchema,
  label: z.string(),
  active: z.boolean(),
  bindingActive: z.boolean(),
  connectionActive: z.boolean(),
  lastHealthStatus: z.string().nullable(),
  lastHealthAt: z.date().nullable(),
  breakerOpenedAt: z.date().nullable(),
  hasSecrets: z.boolean(),
  integrationSecretSet: z.boolean(),
  agentAccess: z.enum(AGENT_ACCESS_VALUES),
  agentPathKind: z.enum(['none', 'core-mediated', 'direct-mcp']),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const bindingListSchema = z.object({
  bindings: z.array(bindingSummarySchema),
  items: z.array(bindingSummarySchema),
});

/** A credential as its owner reads it: never the secret bytes, only whether there are some. */
export const connectionSummarySchema = z.object({
  id: z.string(),
  ownerType: z.enum(integrationOwnerTypes),
  ownerId: z.string(),
  provider: providerSchema,
  displayName: z.string().nullable(),
  config: z.unknown(),
  active: z.boolean(),
  lastHealthStatus: z.string().nullable(),
  lastHealthAt: z.date().nullable(),
  breakerOpenedAt: z.date().nullable(),
  hasSecrets: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const healthResultSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error', 'needs_reauth', 'needs_scope']),
  message: z.string().optional(),
  diagnostics: configSchema.optional(),
});

const createdBindingShape = {
  integration: bindingSummarySchema,
  integrationSecret: z.string(),
  health: healthResultSchema.nullable(),
};

/** A binding just made, with the inbound secret it shows once and the first probe it took. */
const createdBindingSchema = z.object(createdBindingShape);

/** The same, plus whatever the provider says a bind adds (GitHub adds the `repoUrl` it synced). */
export const boundConnectionSchema = z.object(createdBindingShape).catchall(z.unknown());

const bindingChangedSchema = z.object({ integration: bindingSummarySchema });
const rotatedSecretSchema = z.object({
  integration: bindingSummarySchema,
  integrationSecret: z.string(),
});
const deliveryListSchema = z.object({ items: z.array(tableRow(integrationDeliveries)) });
const retryQueuedSchema = z.object({ requestId: z.string(), queued: z.literal(true) });

// List the Rocket.Chat rooms the bot can serve, so the UI offers a name picker
// instead of making the operator dig up raw rids. Two modes: `integrationId`
// reuses the stored (decrypted) bot credential of an existing binding; the
// bare credential fields serve the first-time connect form, before anything
// is persisted. Rooms = whatever the bot user is a member of (channels +
// private groups) — exactly the set it can read/reply in.
export const rocketchatRoomsSchema = z
  .object({
    integrationId: z.string().uuid().optional(),
    serverUrl: z.string().url().max(500).optional(),
    authToken: z.string().min(8).max(2000).optional(),
    userId: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.integrationId || (b.serverUrl && b.authToken && b.userId), {
    message: 'pass integrationId, or serverUrl + authToken + userId',
  });

const roomsSchema = z.object({
  rooms: z.array(z.object({ rid: z.string(), name: z.string(), type: z.enum(['c', 'p']) })),
});

const statusCardsSchema = z.object({
  cards: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      status: z.enum([
        'connected',
        'attention',
        'error',
        'not_configured',
        'disabled',
        'unverified',
      ]),
      detail: z.string(),
      lastSyncAt: z.string().nullable(),
      configured: z.boolean(),
      meta: configSchema.optional(),
    }),
  ),
});

const mcpPreviewSchema = z.object({
  servers: z.array(
    z.object({
      source: z.enum(['integration', 'project']),
      provider: providerSchema.nullable(),
      serverName: z.string(),
      bindingId: z.string().nullable(),
      role: z.enum(bindingRoles).nullable(),
      stages: z.array(z.enum(deployStages)),
      configured: z.boolean(),
      active: z.boolean(),
      willInject: z.boolean(),
      reason: z.enum([
        'ok',
        'not_configured',
        'disabled',
        'no_credential',
        'shadowed',
        'not_granted',
        'not_resolved',
      ]),
      url: z.string().nullable(),
      headers: z.record(z.string(), z.string()).nullable(),
      lastHealthStatus: z.string().nullable(),
      lastHealthAt: z.string().nullable(),
    }),
  ),
  droppedNames: z.array(z.string()),
  stateOnlyNames: z.array(z.string()),
});

export {
  bindingChangedSchema,
  createdBindingSchema,
  deliveryListSchema,
  mcpPreviewSchema,
  retryQueuedSchema,
  roomsSchema,
  rotatedSecretSchema,
  statusCardsSchema,
};

export const noRoleOnProject = fail('FORBIDDEN', 'the caller holds no role on the project');
export const notProjectAdmin = fail('FORBIDDEN', 'the caller is not a project admin');
export const noSuchBinding = fail('NOT_FOUND', 'no such project, or no such integration on it');
export const vaultMissing = fail(
  'VAULT_NOT_CONFIGURED',
  'the server has no INTEGRATION_MASTER_KEY, so it cannot store a credential',
);

export const listIntegrations = onProject(
  describeOperation({
    summary: "List a project's integration bindings",
    description: 'Rows sit under both `bindings` and `items`: `items` is the alias the CLI reads.',
    responses: {
      200: json(bindingListSchema),
      403: noRoleOnProject,
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
    },
  }),
);

export const createIntegration = onProject(
  describeOperation({
    summary: 'Connect an integration: make its credential and bind it to the project in one act',
    description:
      'The inbound secret is in `integrationSecret` and is shown once. Probes the provider at once, so `health` is null where the provider does not answer in five seconds.',
    responses: {
      201: json(createdBindingSchema, 'The binding, its inbound secret and the first probe'),
      400: fail(
        'BAD_REQUEST',
        'the provider is not declared, the config or secrets do not fit it, or the provider has no agent path to grant',
      ),
      403: fail(
        'FORBIDDEN',
        'the caller is not a project admin, or is not an org admin where the org owns the connection or a direct agent grant is asked',
      ),
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
      409: fail({
        ORG_MISMATCH: "the named org is not the project's own org",
        ALREADY_EXISTS: 'an active service binding of this provider (and label) is already there',
      }),
      503: vaultMissing,
    },
  }),
);

export const updateIntegration = onBinding(
  describeOperation({
    summary: "Change a binding's config, secrets, stages, instructions, agent grant or switch",
    description:
      'Connection-tier config and secrets of an org-owned credential take an org admin; a key sent as null is removed.',
    responses: {
      200: json(bindingChangedSchema, 'The binding as it now stands'),
      400: fail({
        BAD_REQUEST:
          'the config or secrets do not fit the provider, or it has no agent path to grant',
        STAGES_ON_NON_DEPLOY_BINDING: 'stages were sent for a binding whose role is not deploy',
      }),
      403: fail(
        'FORBIDDEN',
        'the caller is not a project admin, or is not an org admin where the credential is org-owned or a direct agent grant is asked',
      ),
      404: noSuchBinding,
      409: fail({
        CONNECTION_REMOVED:
          'the binding was switched on over a removed connection, which holds no key to resolve',
        CREDENTIAL_UNREADABLE: `${UNREADABLE_WHEN}, and only part of a new one was sent`,
      }),
      503: vaultMissing,
    },
  }),
);

export const removeIntegration = onBinding(
  describeOperation({
    summary: 'Disconnect a binding from the project',
    description: 'Soft-deletes the binding only; the connection may be shared and stays.',
    responses: { 200: json(okSchema), 403: notProjectAdmin, 404: noSuchBinding },
  }),
);

export const testIntegration = onBinding(
  describeOperation({
    summary: 'Probe a binding now and answer how its provider replied',
    responses: {
      200: json(healthResultSchema),
      400: fail('NO_ADAPTER', 'no adapter is registered for the binding provider'),
      403: noRoleOnProject,
      404: noSuchBinding,
      409: fail('CONNECTION_REMOVED', 'the connection was removed and holds no key to test'),
    },
  }),
);

export const listRocketchatRooms = onProject(
  describeOperation({
    summary: 'List the Rocket.Chat rooms the bot can serve, for a name picker',
    description:
      'Give `integrationId` to use the stored bot credential, or `serverUrl`, `authToken` and `userId` before anything is saved. At most 200 rooms; none on any failure to reach the server.',
    responses: {
      200: json(roomsSchema),
      403: noRoleOnProject,
      404: noSuchBinding,
      409: fail({
        MISSING_CREDENTIALS: 'the stored connection has no server url or credentials',
        CREDENTIAL_UNREADABLE: UNREADABLE_WHEN,
      }),
    },
  }),
);

export const rotateIntegrationSecret = onBinding(
  describeOperation({
    summary: 'Mint a new inbound webhook secret for a binding; the old one stops working',
    responses: {
      200: json(rotatedSecretSchema, 'The binding and its new secret, shown once'),
      403: notProjectAdmin,
      404: noSuchBinding,
    },
  }),
);

export const listDeliveries = onBinding(
  describeOperation({
    summary: "A binding's fifty latest deliveries, newest first",
    responses: { 200: json(deliveryListSchema), 403: noRoleOnProject, 404: noSuchBinding },
  }),
);

export const retryDelivery = onDelivery(
  describeOperation({
    summary: 'Queue a failed outbound delivery again under a fresh request id',
    responses: {
      202: json(retryQueuedSchema, 'Queued; the new delivery row appears when the worker runs'),
      403: notProjectAdmin,
      404: fail('NOT_FOUND', 'no such project, integration or delivery on it'),
      409: fail('NOT_RETRYABLE', 'only a failed outbound delivery can be retried'),
    },
  }),
);

export const readIntegrationsStatus = onProject(
  describeOperation({
    summary: 'The integrations hub: one card per binding and per built-in surface',
    responses: {
      200: json(statusCardsSchema),
      403: noRoleOnProject,
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
    },
  }),
);

export const previewMcpServers = onProject(
  describeOperation({
    summary:
      'Every MCP server a project-wide agent session would receive, and why each is or is not in',
    responses: {
      200: json(mcpPreviewSchema),
      403: noRoleOnProject,
      404: fail('NOT_FOUND', 'no such project, or the caller cannot see it'),
    },
  }),
);
