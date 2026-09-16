/**
 * The generic create, bind and PATCH shapes — provider-agnostic, and the only file that turns a
 * caller's `provider` string into the schemas that validate its body.
 *
 * ISS-1071 reversed what this file's header used to say. It said adding a provider meant editing
 * here: "a branch in the two create discriminated unions … The dispatch stays in THIS file either
 * way, so one place still answers 'which providers exist'." Neither union exists any more, and the
 * answer moved to the declaration each provider carries in its own directory. This file asks the
 * registry a question; it holds no provider's name and no provider's shape.
 *
 * A provider name no declaration holds is refused BY NAME, listing the declared set, rather than
 * falling through to a default schema — the old dispatch ended every lookup with a bare `return
 * coolifyConfigSchema.partial()`, so a typo'd provider was validated against Coolify's shape.
 */

import { z } from 'zod';
import { bindingShapeFields, checkBindingShape } from './binding-shape.js';
import { getIntegration, providerNames } from './registry.js';
import { mergeRotatedSecrets } from './rotation.js';
import { assertVaultConfigured, badRequest } from './route-helpers.js';
import { AGENT_ACCESS_VALUES } from './agent-access.js';
import type { IntegrationDeclaration } from './types.js';

/** The sentence a caller gets for a provider this deployment does not declare. */
export function undeclaredProviderMessage(provider: string): string {
  return `\`${provider}\` is not an integration this deployment declares. Declared providers: ${providerNames().join(', ')}.`;
}

/**
 * The declaration for a caller-supplied provider string, or a `ctx` issue naming what was rejected.
 *
 * Returns `null` on refusal so the caller can stop rather than validate against a guessed shape.
 */
function declarationOrIssue(
  provider: string,
  ctx: z.RefinementCtx,
): IntegrationDeclaration | null {
  const decl = getIntegration(provider);
  if (decl) return decl;
  ctx.addIssue({ code: 'custom', path: ['provider'], message: undeclaredProviderMessage(provider) });
  return null;
}

/** Validate one half of a body against a provider-declared schema, reporting under its own key. */
function parseInto(
  schema: z.ZodTypeAny,
  value: unknown,
  key: 'config' | 'secrets',
  ctx: z.RefinementCtx,
): Record<string, unknown> | undefined {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ ...issue, path: [key, ...issue.path] });
  }
  return undefined;
}

const agentAccessField = z.enum(AGENT_ACCESS_VALUES).optional();

/**
 * Split a validated provider config into its connection-tier and binding-tier halves, reading the
 * binding-tier key list off the provider's own declaration. A provider with no binding-tier keys
 * passes through untouched.
 */
export function splitProviderConfig(
  provider: string,
  config: Record<string, unknown>,
): { connection: Record<string, unknown>; binding: Record<string, unknown> } {
  const bindingKeys = getIntegration(provider)?.schemas.bindingConfigKeys;
  if (!bindingKeys || bindingKeys.length === 0) return { connection: config, binding: {} };
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

/**
 * Body for `POST /:projectId/integrations` — one envelope over every provider.
 *
 * `config` and `secrets` arrive loose and are re-parsed inside the refinement against the schemas
 * the provider's declaration carries, because zod cannot pick a branch on a value the registry
 * resolves at request time. The transform then REPLACES them with the parsed values, so defaults
 * (postman's `region`, coolify's generated target ids) still reach the handler.
 */
// cm:guard `label` is accepted only where the provider declares `multiBinding` — the column exists on
// every binding but a second row of a single-binding provider collides on `integration_bindings_service_uq`,
// and a label silently kept on a provider that cannot use it reads to an operator as a named binding
// they can add more of.
export const createSchema = z
  .object({
    provider: z.string().min(1).max(60),
    ...bindingShapeFields,
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).default({}),
    orgId: z.uuid().optional(),
    label: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'label must be kebab-case (a-z0-9-)')
      .optional(),
    agentAccess: agentAccessField,
  })
  .superRefine(checkBindingShape)
  .transform((value, ctx) => {
    const decl = declarationOrIssue(value.provider, ctx);
    if (!decl) return z.NEVER;
    if (value.label !== undefined && !decl.capabilities.multiBinding) {
      ctx.addIssue({
        code: 'custom',
        path: ['label'],
        message: `\`${decl.provider}\` holds one binding per project, so it takes no \`label\`. A label names one of several bindings of the same provider, which only a provider declaring \`multiBinding\` has.`,
      });
      return z.NEVER;
    }
    const config = parseInto(decl.schemas.bindingConfig, value.config, 'config', ctx);
    const secrets = parseInto(decl.schemas.secrets, value.secrets, 'secrets', ctx);
    if (config === undefined || secrets === undefined) return z.NEVER;
    return { ...value, provider: decl.provider, config, secrets };
  });

// cm:guard this shape is loose ON PURPOSE — a PATCH carries no provider, so `config`/`secrets` are
// re-validated against the EXISTING binding's provider inside the handler; tightening it here would
// validate against a provider nobody named
export const updateSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
  // cm:why deliberately NOT a provider-config key — this is Forge-side prompt text, so routing it through the provider's own config schema would force every provider to carry a field none of them consume
  instructions: z.string().max(4000).nullable().optional(),
  agentAccess: agentAccessField,
});

/** Body for `POST /integration-connections` — the owner-scoped half, with no binding shape. */
export const connectionCreateSchema = z
  .object({
    provider: z.string().min(1).max(60),
    displayName: z.string().min(1).max(200).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.unknown()).default({}),
    orgId: z.uuid().optional(),
  })
  .transform((value, ctx) => {
    const decl = declarationOrIssue(value.provider, ctx);
    if (!decl) return z.NEVER;
    const config = parseInto(decl.schemas.connectionConfig, value.config, 'config', ctx);
    const secrets = parseInto(decl.schemas.secrets, value.secrets, 'secrets', ctx);
    if (config === undefined || secrets === undefined) return z.NEVER;
    return { ...value, provider: decl.provider, config, secrets };
  });

export const connectionUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
});

/**
 * The partial config schema a binding PATCH validates against, read off the provider's declaration.
 *
 * Throws rather than falling back, and the sentence names the provider. The function this replaced
 * ended in `return coolifyConfigSchema.partial()`, so every unknown provider — including a typo —
 * was validated against Coolify's shape and told nothing.
 */
export function configSchemaForProvider(provider: string): z.ZodTypeAny {
  const decl = getIntegration(provider);
  if (!decl) throw badRequest(undeclaredProviderMessage(provider));
  return decl.schemas.patchConfig;
}

/** The config schema for an OWNER-SCOPED connection PATCH, where a binding-tier key does not belong. */
// cm:guard only `google` narrows this today, and that is a statement about scope rather than about the other providers: `coolify` carries `targets` and every provider carries the three release-channel keys through this same door, so a connection PATCH can put a binding-tier key on a shared credential for all of them. That is a pre-existing hole ISS-1036 found and did not widen; narrowing the rest changes what six live providers accept and is somebody's own change to make. What ISS-1071 changed is only WHERE the narrowing is declared — on google's declaration rather than in a branch here.
export function connectionConfigSchemaForProvider(provider: string): z.ZodTypeAny {
  const decl = getIntegration(provider);
  if (!decl) throw badRequest(undeclaredProviderMessage(provider));
  return decl.schemas.connectionConfig;
}

/**
 * Shared secrets-rotation step of the two PATCH paths (binding PATCH in `routes.ts`, connection
 * PATCH in `connection-routes.ts`): declared-schema parse → secret-input detection → vault decrypt
 * of the current blob → dual-token merge (ISS-405). A provider declaring no primary credential
 * field is a no-op. Returns the merged secrets to persist, or `undefined` when nothing should be
 * written (no secret input, or the merge produced nothing).
 *
 * `vaultGuardTiming` preserves each caller's historical order of operations: the connection PATCH
 * asserts the vault BEFORE parsing; the binding PATCH asserts it only once a real credential field
 * is present, so a config-only secrets object never 503s on a vault-less deploy.
 */
export async function applySecretsPatch(opts: {
  provider: string;
  rawSecrets: Record<string, unknown>;
  secretsEnc: Buffer | null;
  vaultGuardTiming: 'before-parse' | 'on-secret-input';
}): Promise<Record<string, unknown> | undefined> {
  const decl = getIntegration(opts.provider);
  const primaryField = decl?.schemas.primaryCredentialField;
  if (!decl || !primaryField) return undefined;
  if (opts.vaultGuardTiming === 'before-parse') assertVaultConfigured();
  const parsedSecrets = decl.schemas.patchSecrets.safeParse(opts.rawSecrets);
  if (!parsedSecrets.success) throw badRequest(z.flattenError(parsedSecrets.error));
  const incoming = parsedSecrets.data as Record<string, unknown>;
  // A field a rotation does not touch is writable on its own only where the provider DECLARES it
  // so. Rocket.Chat's bot `userId` is the only one today. Treating every non-primary field as
  // independently writable would make a github PATCH naming `appId` alone look like a credential
  // edit, which it is not: that App's three fields arrive together or not at all.
  const independent = decl.schemas.independentSecretFields;
  const secondaryFields = Object.keys(incoming).filter(
    (k) => k !== primaryField && independent.includes(k),
  );
  const hasSecretInput =
    typeof incoming[primaryField] === 'string' || secondaryFields.length > 0;
  if (!hasSecretInput) return undefined;
  if (opts.vaultGuardTiming === 'on-secret-input') assertVaultConfigured();
  const currentSecrets = opts.secretsEnc
    ? (await import('./vault.js')).decryptJson<Record<string, unknown>>(opts.secretsEnc)
    : null;
  const merged = mergeRotatedSecrets(decl, currentSecrets, incoming);
  if (merged) {
    for (const field of secondaryFields) merged[field] = incoming[field];
    return merged;
  }
  // No new primary credential — allow updating a secondary field alone.
  if (secondaryFields.length === 0) return undefined;
  const next = { ...(currentSecrets ?? {}) };
  for (const field of secondaryFields) next[field] = incoming[field];
  return next;
}
