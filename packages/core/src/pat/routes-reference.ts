import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';

/** A token as a listing shows it: never the secret, which only a mint or a rotation returns. */
export const publicTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(z.string()).nullable(),
  permissions: z.array(z.string()).nullable(),
  grant: z.enum(['legacy', 'full', 'named']),
  boundProjectId: z.string().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: z.date().nullable(),
});

/** A freshly minted token, the one time its secret is shown. */
export const mintedTokenSchema = publicTokenSchema.extend({ plaintext: z.string() });

export const tokenListSchema = z.object({
  tokens: z.array(publicTokenSchema),
  menu: z.object({
    permissions: z.array(z.string()),
    accountOnly: z.array(z.string()),
    full: z.string(),
  }),
});

export const auditSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      tool: z.string(),
      action: z.string().nullable(),
      projectId: z.string().nullable(),
      resultCode: z.string(),
      requestId: z.string().nullable(),
      ip: z.string().nullable(),
      userAgent: z.string().nullable(),
      createdAt: z.date(),
    }),
  ),
});

export const listTokens = describeOperation({
  summary:
    "List the caller's personal access tokens and the permission menu a new one may draw from",
  responses: { 200: json(tokenListSchema) },
});

export const mintToken = describeOperation({
  summary: 'Mint a personal or agent token that names what it may reach',
  description:
    'The secret is in `plaintext` and is shown once. Needs a session that authenticated in the last five minutes, and a token cannot call it.',
  responses: {
    201: json(mintedTokenSchema, 'The token, with its secret'),
    400: fail({
      PAT_PERMISSIONS_REQUIRED: 'no `permissions`: name the groups the token needs, or `["*"]`',
      PAT_PERMISSIONS_FULL_NOT_COMBINABLE: '`*` was sent with other permissions',
      PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN: 'an account permission on a token fenced to projects',
    }),
    403: fail('FORBIDDEN_PROJECT', 'the caller cannot see a project the token is fenced to'),
    409: fail('PAT_NAME_CONFLICT', 'an active token already has this name'),
    422: fail('PAT_LIMIT', 'the caller holds the maximum number of active tokens'),
  },
});

export const revokeToken = describeOperation({
  summary: 'Revoke a token',
  responses: {
    200: json(publicTokenSchema, 'The revoked token'),
    404: fail('NOT_FOUND', 'the caller holds no such token'),
  },
});

export const readTokenAudit = describeOperation({
  summary: 'Read what a token did, newest first',
  responses: { 200: json(auditSchema), 404: fail('NOT_FOUND', 'the caller holds no such token') },
});

export const rotateToken = describeOperation({
  summary: "Replace a token's secret and keep its grant; the old secret stops working",
  description:
    'Needs a session that authenticated in the last five minutes. The new secret is in `plaintext`.',
  responses: {
    200: json(mintedTokenSchema, 'The new token, with its secret'),
    404: fail('NOT_FOUND', 'the caller holds no such token'),
  },
});
