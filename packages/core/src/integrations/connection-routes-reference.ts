import type { ConnectionReach } from '@forge/contracts';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { bindingRoles, deployStages } from '../db/schema.js';
import { UNREADABLE_WHEN } from './credential-unreadable.js';
import {
  connectionBindingListSchema,
  boundConnectionSchema,
  connectionSummarySchema,
  healthResultSchema,
  inConnection,
  okSchema,
  vaultMissing,
} from './routes-reference.js';

// Listed here, not imported: core loads no runtime value from the contracts root. A value added there
// fails `tsc` where a handler answers it, because `answer` holds the body to this schema.
const REACH = ['owner', 'org', 'binding'] as const satisfies readonly ConnectionReach[];

const onConnection = (op: MiddlewareHandler) => [op, inConnection] as const;

const directoryItemSchema = connectionSummarySchema.extend({
  access: z.object({
    reach: z.enum(REACH),
    canManage: z.boolean(),
    ownerName: z.string().nullable(),
  }),
  usage: z.object({
    bindings: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        role: z.enum(bindingRoles),
        stages: z.array(z.enum(deployStages)),
        label: z.string(),
        active: z.boolean(),
      }),
    ),
  }),
});

export const directorySchema = z.object({ items: z.array(directoryItemSchema) });
export const connectionAnswerSchema = z.object({ connection: connectionSummarySchema });
export { connectionBindingListSchema, boundConnectionSchema, healthResultSchema, okSchema };

const unreachable =
  'the connection does not exist, or the caller neither owns it, shares its org nor administers a project it is bound to';
const unmanageable =
  'the caller can see the connection but is not its owner (or an org owner or admin where an org owns it)';

/** `orgId` narrows the list to the connections that organization owns (ISS-1421 r20). */
export const listConnectionsQuerySchema = z.object({ orgId: z.uuid().optional() }).strict();

export const listConnections = describeOperation({
  summary: 'The credentials the caller can reach, each with where it is used',
  description:
    'A connection is visible to its owner, to the members of the org that owns it and to an admin of a project it is bound to. `access.canManage` says which of them may change it. `orgId` lists only the connections that organization owns.',
  responses: { 200: json(directorySchema) },
});

export const storeConnection = describeOperation({
  summary: 'Store a credential of the caller, or of an org the caller administers',
  responses: {
    201: json(connectionAnswerSchema, 'The connection, without its secrets'),
    403: fail('FORBIDDEN', 'the caller is not an admin of the org that would own it'),
    404: fail('NOT_FOUND', 'the named org does not exist, or the caller is not in it'),
    503: vaultMissing,
  },
});

export const bindConnection = onConnection(
  describeOperation({
    summary: 'Bind an existing credential to a project, with no new secret',
    description:
      'The caller must manage the connection and administer the target project. The inbound secret is shown once, and a provider may add fields of its own to the answer.',
    responses: {
      201: json(boundConnectionSchema, 'The binding, its inbound secret and the first probe'),
      400: fail(
        'BAD_REQUEST',
        'the provider cannot deploy, its config does not fit, or it has no agent path to grant',
      ),
      403: fail({
        CONNECTION_NOT_MANAGEABLE: unmanageable,
        FORBIDDEN:
          'the caller is not an admin of the target project, or not an org admin where a direct agent grant is asked',
      }),
      404: fail({
        CONNECTION_NOT_REACHABLE: unreachable,
        NOT_FOUND: 'the target project does not exist, or the caller cannot see it',
      }),
      409: fail({
        ORG_MISMATCH: 'an org connection can only bind to projects of its own org',
        ALREADY_EXISTS: 'the project already has an active service binding of this provider',
        CONNECTION_REMOVED:
          'the connection was removed and holds no key, so no binding could resolve',
      }),
    },
  }),
);

export const listConnectionBindings = onConnection(
  describeOperation({
    summary: 'The bindings of a connection the caller may see',
    responses: {
      200: json(connectionBindingListSchema),
      404: fail('CONNECTION_NOT_REACHABLE', unreachable),
    },
  }),
);

export const testConnection = onConnection(
  describeOperation({
    summary: 'Probe a connection through its oldest active binding',
    description: 'A probe that does not answer in ten seconds is an `error` result, not a failure.',
    responses: {
      200: json(healthResultSchema),
      400: fail('NO_ADAPTER', 'no adapter is registered for the provider'),
      403: fail('CONNECTION_NOT_MANAGEABLE', unmanageable),
      404: fail({
        CONNECTION_NOT_REACHABLE: unreachable,
        NO_BINDING: 'the connection has no active binding to probe through',
      }),
      409: fail('CONNECTION_REMOVED', 'the connection was removed and holds no key to test'),
    },
  }),
);

export const changeConnection = onConnection(
  describeOperation({
    summary: 'Rename, re-key, reconfigure or switch a connection on or off',
    description: 'A config key sent as null is removed.',
    responses: {
      200: json(connectionAnswerSchema, 'The connection as it now stands'),
      400: fail('BAD_REQUEST', 'the config or secrets do not fit the provider'),
      403: fail('CONNECTION_NOT_MANAGEABLE', unmanageable),
      404: fail({
        CONNECTION_NOT_REACHABLE: unreachable,
        NOT_FOUND: 'the connection was removed while the change was made',
      }),
      409: fail({
        CONNECTION_HAS_NO_KEY:
          'the connection was deleted and holds no key, so it is turned on only with a new key',
        CREDENTIAL_UNREADABLE: `${UNREADABLE_WHEN}, and only part of a new one was sent`,
      }),
      503: vaultMissing,
    },
  }),
);

export const removeConnection = onConnection(
  describeOperation({
    summary:
      'Remove a credential: every key stored on it is wiped, it is switched off and its bindings stop resolving; removing one already removed clears it from the list, its bindings with it',
    responses: {
      200: json(okSchema),
      403: fail('CONNECTION_NOT_MANAGEABLE', unmanageable),
      404: fail('CONNECTION_NOT_REACHABLE', unreachable),
      409: fail(
        'CONNECTION_CHANGED',
        'a key was saved on the removed connection, or it was turned back on, while it was being cleared, so it was kept',
      ),
    },
  }),
);
