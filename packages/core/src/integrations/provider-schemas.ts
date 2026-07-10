/**
 * Per-provider integration config + secrets schemas and dispatch tables.
 *
 * Adding a provider = edit THIS file only: its config/secrets schemas, a
 * branch in the two create discriminated unions (project-scoped create +
 * owner-scoped connection create), and the per-provider dispatch functions
 * (configSchemaForProvider / secretsSchemaForProvider /
 * primaryFieldForProvider — plus BINDING_CONFIG_KEYS when the provider has
 * binding-tier config). The route modules stay provider-agnostic.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { integrationEnvironments } from '../db/schema.js';
import { type RotatingProvider, isRotatingProvider, mergeRotatedSecrets } from './rotation.js';
import { assertVaultConfigured, badRequest } from './route-helpers.js';

export const environmentSchema = z.enum(integrationEnvironments);

// A deploy target = one Coolify application. `id` is server-assigned when
// omitted (a stable key mapping an outbound deploy to its inbound webhook).
const coolifyTargetSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().min(1).max(100),
    resourceUuid: z.string().min(1).max(200),
  })
  .transform((t) => ({ id: t.id ?? randomUUID(), label: t.label, resourceUuid: t.resourceUuid }));

const coolifyConfigSchema = z.object({
  baseUrl: z.string().url().max(500),
  // One binding fans out to ≥1 target (split BE/FE deploy as separate apps).
  targets: z.array(coolifyTargetSchema).min(1).max(20),
});

// Coolify's deploy targets are BINDING-tier: two projects sharing one connection
// (org-shared credential) each deploy their own Coolify resources, so `targets`
// lives on binding.config (overlaid over connection.config at dispatch — binding
// wins). Everything else (baseUrl) stays connection-tier with the credential.
const COOLIFY_BINDING_CONFIG_KEYS = ['targets'] as const;

/** Provider → binding-tier config keys (everything else stays on the
 *  connection with the credential). Coolify: per-project deploy targets;
 *  Rocket.Chat: the per-project room ids. */
const BINDING_CONFIG_KEYS: Record<string, readonly string[]> = {
  coolify: COOLIFY_BINDING_CONFIG_KEYS,
  rocketchat: ['rids'],
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

// ISS-336 — Postman provider. Config is the non-secret write-target; the
// API key (PMAK-...) is the only secret and is vault-encrypted like coolify's.
// `postmanConfigBase` carries NO defaults so `.partial()` is a true partial for
// PATCH (Zod's `.partial()` still EMITS a field's `.default()` when the key is
// absent, which would silently reset region/mode/workspaceName on a partial
// update). Defaults live only on the create schema below.
const postmanConfigBase = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  workspaceName: z.string().min(1).max(200),
  collectionId: z.string().min(1).max(200).optional(),
  region: z.enum(['us', 'eu']),
  mode: z.enum(['minimal', 'full']),
});

const postmanConfigSchema = postmanConfigBase.extend({
  workspaceName: postmanConfigBase.shape.workspaceName.default('Forge Integration'),
  region: postmanConfigBase.shape.region.default('us'),
  mode: postmanConfigBase.shape.mode.default('minimal'),
});

const postmanSecretsSchema = z.object({
  apiKey: z.string().min(8).max(2000),
});

// ISS-387 — Epodsystem provider. One store per project; staging↔theme draft,
// prod↔theme main. Config is the non-secret store context; the `crmk_` API key
// is the only secret and is vault-encrypted like coolify/postman. The endpoint
// is NOT user config — it is fixed platform config (EPODSYSTEM_ENDPOINT env).
// Store identity fields (slug/name/theme ids) are filled by the healthcheck, so
// every config field is optional on input — the operator only supplies the key.
const epodsystemConfigBase = z.object({
  storeSlug: z.string().min(1).max(200).optional(),
  storeName: z.string().min(1).max(200).optional(),
  themeId: z.string().min(1).max(200).optional(),
  draftThemeId: z.string().min(1).max(200).optional(),
  commerceEnabled: z.boolean().optional(),
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
});

const rocketchatSecretsSchema = z.object({
  authToken: z.string().min(8).max(2000),
  userId: z.string().min(1).max(200),
});

// Discriminated on `provider` so each provider validates its own config +
// secrets shape. `environment` defaults to 'prod' for postman (it has no
// staging/prod split, but the binding column + unique index require a value).
export const createSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('coolify'),
    environment: environmentSchema,
    config: coolifyConfigSchema,
    secrets: coolifySecretsSchema,
    // Present = mint the credential as ORG-owned (shared across the org's
    // projects); must equal the project's own org and the caller must be an
    // org admin. Absent = personal (user-owned), the historical default.
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('postman'),
    environment: environmentSchema.default('prod'),
    config: postmanConfigSchema,
    secrets: postmanSecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('epodsystem'),
    environment: environmentSchema.default('prod'),
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
    environment: environmentSchema.default('prod'),
    config: sentryConfigBase,
    secrets: sentrySecretsSchema,
    orgId: z.uuid().optional(),
  }),
  z.object({
    provider: z.literal('rocketchat'),
    environment: environmentSchema.default('prod'),
    config: rocketchatConfigBase,
    secrets: rocketchatSecretsSchema,
    orgId: z.uuid().optional(),
  }),
]);

// PATCH carries no provider, so config/secrets are validated loosely here and
// re-validated against the EXISTING binding's provider inside the handler.
export const updateSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
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
  return coolifyConfigSchema.partial();
}

/** Per-provider partial secrets schema for the two PATCH paths. */
function secretsSchemaForProvider(provider: RotatingProvider): z.ZodTypeAny {
  if (provider === 'coolify') return coolifySecretsSchema.partial();
  if (provider === 'sentry') return sentrySecretsSchema.partial();
  if (provider === 'rocketchat') return rocketchatSecretsSchema.partial();
  return postmanSecretsSchema.partial();
}

/** Provider → primary (rotating) credential field, mirroring rotation.ts. */
function primaryFieldForProvider(provider: RotatingProvider): string {
  if (provider === 'coolify') return 'apiToken';
  if (provider === 'sentry' || provider === 'rocketchat') return 'authToken';
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
