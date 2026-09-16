/**
 * Per-provider integration config + secrets schemas and dispatch tables.
 *
 * Adding a provider = its config/secrets schemas, a branch in the two create
 * discriminated unions (project-scoped create + owner-scoped connection
 * create), and the per-provider dispatch functions (configSchemaForProvider /
 * connectionConfigSchemaForProvider / secretsSchemaForProvider /
 * primaryFieldForProvider — plus BINDING_CONFIG_KEYS when the provider has
 * binding-tier config). The route modules stay provider-agnostic.
 *
 * A provider that owns a directory may declare its shapes there and be imported
 * here — `google/schemas.ts` does. The dispatch stays in THIS file either way,
 * so one place still answers "which providers exist".
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bindingShapeFields, checkBindingShape } from './binding-shape.js';
import {
  googleConfigBase,
  googleConnectionConfigSchema,
  googleSecretsSchema,
} from './google/schemas.js';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from './release-channel-schema.js';
import { isRotatingProvider, mergeRotatedSecrets, type RotatingProvider } from './rotation.js';
import { assertVaultConfigured, badRequest } from './route-helpers.js';

const coolifyTargetSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(100),
    resourceUuid: z.string().min(1).max(200),
    healthUrl: z.string().url().max(500).optional(),
  })
  .transform((t) => ({
    id: t.id ?? randomUUID(),
    label: t.label,
    resourceUuid: t.resourceUuid,
    ...(t.healthUrl ? { healthUrl: t.healthUrl } : {}),
  }));

export const COOLIFY_ROLLBACK_MODE = 'coolify-image' as const;

const COOLIFY_ROLLBACK_PROSE_REFUSAL =
  'rollback on a Coolify binding is an action, not a paragraph: Coolify exposes `GET /applications/{uuid}/rollback-images` and `POST /applications/{uuid}/rollback`, and Forge performs them. Send {"mode":"coolify-image"}. Free text is kept only for channels whose API cannot express a rollback (ISS-925).';

/**
 * The Coolify override of `releaseChannelFields.rollback`. Written as a hand
 * rolled refinement rather than a zod object so the refusal of the OLD prose
 * value is a sentence naming the replacement, not `expected object, received
 * string`.
 */
const coolifyRollbackSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') {
      ctx.addIssue({ code: 'custom', message: COOLIFY_ROLLBACK_PROSE_REFUSAL });
      return;
    }
    const ok =
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      (value as { mode?: unknown }).mode === COOLIFY_ROLLBACK_MODE;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'rollback must be exactly {"mode":"coolify-image"}',
      });
    }
  })
  .transform((value) => value as { mode: typeof COOLIFY_ROLLBACK_MODE } | undefined)
  .optional();

const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  targets: z
    .array(coolifyTargetSchema)
    .min(1)
    .max(20)
    .superRefine((targets, ctx) => {
      const seen = new Set<string>();
      for (const t of targets) {
        if (seen.has(t.label)) {
          ctx.addIssue({
            code: 'custom',
            message: `two deploy targets are both labelled "${t.label}" — a label names one application and must be unique within this binding`,
          });
          return;
        }
        seen.add(t.label);
      }
    }),
  ...releaseChannelFields,
  rollback: coolifyRollbackSchema,
});

const COOLIFY_BINDING_CONFIG_KEYS = ['targets', ...RELEASE_CHANNEL_KEYS] as const;

/** Provider → binding-tier config keys (everything else stays on the
 *  connection with the credential). Coolify: per-project deploy targets;
 *  Rocket.Chat: the per-project room ids; the three release-channel keys for
 *  every provider, because which box releases and how a deploy is proved are
 *  the project's answer even when the credential is shared org-wide. */
const BINDING_CONFIG_KEYS: Record<string, readonly string[]> = {
  coolify: COOLIFY_BINDING_CONFIG_KEYS,
  rocketchat: ['rids', ...RELEASE_CHANNEL_KEYS],
  postman: RELEASE_CHANNEL_KEYS,
  epodsystem: RELEASE_CHANNEL_KEYS,
  sentry: RELEASE_CHANNEL_KEYS,
  github: ['installationId', 'owner', 'repo', ...RELEASE_CHANNEL_KEYS],
  google: ['defaultSpreadsheetId', ...RELEASE_CHANNEL_KEYS],
  agent: RELEASE_CHANNEL_KEYS,
};

/** Split a validated provider config into its connection-tier and binding-tier
 *  halves. Providers without binding-tier keys pass through untouched. */
export function splitProviderConfig(
  provider: string,
  config: Record<string, unknown>,
): { connection: Record<string, unknown>; binding: Record<string, unknown> } {
  const bindingKeys = BINDING_CONFIG_KEYS[provider];
  if (!bindingKeys) return { connection: config, binding: {} };
  const connection: Record<string, unknown> = { ...config };
  const binding: Record<string, unknown> = {};
  for (const key of bindingKeys) {
    if (key in connection) {
      binding[key] = connection[key];
      delete connection[key];
    }
  }
  return { connection, binding };
}

const coolifySecretsSchema = z.object({
  apiToken: z.string().min(8).max(2000),
});

const postmanConfigBase = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  workspaceName: z.string().min(1).max(200),
  collectionId: z.string().min(1).max(200).optional(),
  region: z.enum(['us', 'eu']),
  mode: z.enum(['minimal', 'full']),
  ...releaseChannelFields,
});

const postmanConfigSchema = postmanConfigBase.extend({
  workspaceName: postmanConfigBase.shape.workspaceName.default('Forge Integration'),
  region: postmanConfigBase.shape.region.default('us'),
  mode: postmanConfigBase.shape.mode.default('minimal'),
});

const postmanSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

const epodsystemConfigBase = z.object({
  storeSlug: z.string().min(1).max(200).optional(),
  storeName: z.string().min(1).max(200).optional(),
  themeId: z.string().min(1).max(200).optional(),
  draftThemeId: z.string().min(1).max(200).optional(),
  commerceEnabled: z.boolean().optional(),
  ...releaseChannelFields,
});

const epodsystemSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

// ISS-524 / ISS-526 — Sentry provider. Config is the non-secret target set
// (Sentry host + a labelled `targets[]` list of org/project bindings); the
// `sntryu_` auth token is the only secret and is vault-encrypted like
// coolify/postman. `sentryConfigBase` carries NO defaults so `.partial()` is a
// true partial for PATCH. The host is required on create (the MCP server's
// SENTRY_HOST). The legacy top-level slugs (ISS-524) stay optional for
// back-compat reads; new writes use `targets[]`.
const sentryTargetSchema = z.object({
  label: z.string().min(1).max(120),
  organizationSlug: z.string().min(1).max(200).optional(),
  projectSlug: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(120).optional(),
  notes: z.string().max(2000).optional(),
});
const sentryConfigBase = z.object({
  host: z.string().min(1).max(255),
  targets: z.array(sentryTargetSchema).max(50).optional(),
  organizationSlug: z.string().min(1).max(200).optional(),
  projectSlug: z.string().min(1).max(200).optional(),
  ...releaseChannelFields,
});

const sentrySecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
});

// ISS-609 — Rocket.Chat provider (connection-only archetype, bot credential).
// Connection-tier config is the server URL; the room ids (`rids`) are
// BINDING-tier (see splitProviderConfig) so one org bot credential serves N
// project channels, and one project can listen on several rooms (mirrors the
// coolify targets[] pattern; migration 0146 rewrote legacy single-`rid` rows).
// Secrets are the bot PAT (X-Auth-Token / DDP resume) + its user id.
const rocketchatConfigBase = z.object({
  serverUrl: z.string().url().max(500),
  rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  ...releaseChannelFields,
});

const rocketchatSecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
  userId: z.string().min(1).max(200),
});

const githubConfigBase = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  apiBaseUrl: z.string().url().max(500).optional(),
  ...releaseChannelFields,
});

const githubSecretsSchema = z.object({
  appId: z.string().min(1).max(50),
  privateKey: z.string().min(100).max(20000),
  webhookSecret: z.string().min(8).max(500),
});

const agentReleaseConfigSchema = z.object(releaseChannelFields);

const createVariants = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('coolify'),
    ...bindingShapeFields,
    config: coolifyConfigSchema,
    secrets: coolifySecretsSchema,
    // Present = mint the credential as ORG-owned (shared across the org's
    // projects); must equal the project's own org and the caller must be an
    // org admin. Absent = personal (user-owned), the historical default.
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('postman'),
    ...bindingShapeFields,
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('epodsystem'),
    ...bindingShapeFields,
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
    orgId: z.uuid().optional(),
    // ISS-558 — optional label for the second+ storefront. Empty = default.
    label: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'label must be kebab-case (a-z0-9-)')
      .optional(),
  }),
  z.object({
    provider: z.literal('sentry'),
    ...bindingShapeFields,
    config: sentryConfigBase,
    secrets: sentrySecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('rocketchat'),
    ...bindingShapeFields,
    config: rocketchatConfigBase,
    secrets: rocketchatSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('github'),
    ...bindingShapeFields,
    config: githubConfigBase,
    secrets: githubSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('google'),
    ...bindingShapeFields,
    config: googleConfigBase,
    secrets: googleSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('agent'),
    ...bindingShapeFields,
    config: agentReleaseConfigSchema,
    secrets: z.object({}).strict().default({}),
    orgId: z.uuid().optional(),
  }),
]);

export const createSchema = createVariants.superRefine(checkBindingShape);

export const updateSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
  instructions: z.string().max(4000).nullable().optional(),
});

// Owner-scoped connection create (no environment — that's a binding concern).
export const connectionCreateSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('coolify'),
    displayName: z.string().min(1).max(200).optional(),
    config: coolifyConfigSchema,
    secrets: coolifySecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('postman'),
    displayName: z.string().min(1).max(200).optional(),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('epodsystem'),
    displayName: z.string().min(1).max(200).optional(),
    config: epodsystemConfigBase,
    secrets: epodsystemSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('sentry'),
    displayName: z.string().min(1).max(200).optional(),
    config: sentryConfigBase,
    secrets: sentrySecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('rocketchat'),
    displayName: z.string().min(1).max(200).optional(),
    config: rocketchatConfigBase,
    secrets: rocketchatSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('github'),
    displayName: z.string().min(1).max(200).optional(),
    config: githubConfigBase,
    secrets: githubSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('google'),
    displayName: z.string().min(1).max(200).optional(),
    config: googleConnectionConfigSchema,
    secrets: googleSecretsSchema,
    orgId: z.uuid().optional(),
  }),
]);

export const connectionUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

/** Per-provider partial config schema for PATCH validation. Uses the
 *  no-default base for postman so a partial patch never re-emits defaults. */
export function configSchemaForProvider(provider: string): z.ZodTypeAny {
  if (provider === 'postman') return postmanConfigBase.partial();
  if (provider === 'epodsystem') return epodsystemConfigBase.partial();
  if (provider === 'sentry') return sentryConfigBase.partial();
  if (provider === 'rocketchat') return rocketchatConfigBase.partial();
  if (provider === 'github') return githubConfigBase.partial();
  if (provider === 'google') return googleConfigBase.partial();
  if (provider === 'agent') return agentReleaseConfigSchema.partial();
  return coolifyConfigSchema.partial();
}

/**
 * The config schema for an OWNER-SCOPED connection PATCH, where a binding-tier
 * key does not belong.
 */
export function connectionConfigSchemaForProvider(provider: string): z.ZodTypeAny {
  // Both of its fields are already optional, so there is no `.partial()` to take.
  if (provider === 'google') return googleConnectionConfigSchema;
  return configSchemaForProvider(provider);
}

/** Per-provider partial secrets schema for the two PATCH paths. */
function secretsSchemaForProvider(provider: RotatingProvider): z.ZodTypeAny {
  if (provider === 'coolify') return coolifySecretsSchema.partial();
  if (provider === 'sentry') return sentrySecretsSchema.partial();
  if (provider === 'rocketchat') return rocketchatSecretsSchema.partial();
  if (provider === 'github') return githubSecretsSchema.partial();
  if (provider === 'google') return googleSecretsSchema.partial();
  return postmanSecretsSchema.partial();
}

/** Provider → primary (rotating) credential field, mirroring rotation.ts. */
function primaryFieldForProvider(provider: RotatingProvider): string {
  if (provider === 'coolify') return 'apiToken';
  if (provider === 'sentry' || provider === 'rocketchat') return 'authToken';
  if (provider === 'github') return 'privateKey';
  if (provider === 'google') return 'serviceAccountJson';
  return 'apiKey';
}

/**
 * Rotate the primary credential via the shared dual-token helper, carrying
 * provider fields the rotation window doesn't know about (rocketchat's bot
 * `userId` must survive an authToken-only rotation). Also supports a
 * rocketchat userId-only update (no token change → plain merge, no rotation).
 */
function mergeProviderSecretsPatch(
  provider: RotatingProvider,
  currentSecrets: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const merged = mergeRotatedSecrets(provider, currentSecrets, incoming);
  if (provider !== 'rocketchat') return merged;
  const userId = typeof incoming.userId === 'string' ? incoming.userId : currentSecrets?.userId;
  if (merged) {
    if (typeof userId === 'string') merged.userId = userId;
    return merged;
  }
  // No new token — allow updating the bot userId alone.
  if (typeof incoming.userId === 'string') {
    return { ...(currentSecrets ?? {}), userId: incoming.userId };
  }
  return null;
}

/**
 * Shared secrets-rotation step of the two PATCH paths (binding PATCH in
 * routes.ts, connection PATCH in connection-routes.ts): per-provider zod
 * parse → secret-input detection → vault decrypt of the current blob →
 * dual-token merge (ISS-405). Non-rotating providers are a no-op. Returns the
 * merged secrets to persist, or `undefined` when nothing should be written
 * (no secret input, or the merge produced nothing).
 *
 * `vaultGuardTiming` preserves each caller's historical order of operations:
 * the connection PATCH asserts the vault BEFORE parsing; the binding PATCH
 * asserts it only once a real credential field is present (so a config-only
 * secrets object never 503s on a vault-less deploy).
 */
export async function applySecretsPatch(opts: {
  provider: string;
  rawSecrets: Record<string, unknown>;
  secretsEnc: Buffer | null;
  vaultGuardTiming: 'before-parse' | 'on-secret-input';
}): Promise<Record<string, unknown> | undefined> {
  // All providers route through the shared rotation helper so the dual-token
  // overlap window applies uniformly (ISS-405). Per-provider zod parsing
  // validates each provider's input shape before the merge.
  if (!isRotatingProvider(opts.provider)) return undefined;
  const provider: RotatingProvider = opts.provider;
  if (opts.vaultGuardTiming === 'before-parse') assertVaultConfigured();
  const parsedSecrets = secretsSchemaForProvider(provider).safeParse(opts.rawSecrets);
  if (!parsedSecrets.success) throw badRequest(z.flattenError(parsedSecrets.error));
  const incoming = parsedSecrets.data as Record<string, unknown>;
  // Skip the vault guard for a config-only PATCH (no credential fields).
  // Rocketchat also accepts a userId-only update (non-rotating secondary
  // field).
  const hasSecretInput =
    typeof incoming[primaryFieldForProvider(provider)] === 'string' ||
    (provider === 'rocketchat' && typeof incoming.userId === 'string');
  if (!hasSecretInput) return undefined;
  if (opts.vaultGuardTiming === 'on-secret-input') assertVaultConfigured();
  const currentSecrets = opts.secretsEnc
    ? (await import('./vault.js')).decryptJson<Record<string, unknown>>(opts.secretsEnc)
    : null;
  const merged = mergeProviderSecretsPatch(provider, currentSecrets, incoming);
  return merged ?? undefined;
}
