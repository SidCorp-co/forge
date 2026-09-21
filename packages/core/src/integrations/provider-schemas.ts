import { z } from 'zod';
import { AGENT_ACCESS_VALUES } from './agent-access.js';
import { bindingShapeFields, checkBindingShape, stagesSchema } from './binding-shape.js';
import { getIntegration, providerNames } from './registry.js';
import { mergeRotatedSecrets } from './rotation.js';
import { assertVaultConfigured, badRequest } from './route-helpers.js';
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
function declarationOrIssue(provider: string, ctx: z.RefinementCtx): IntegrationDeclaration | null {
  const decl = getIntegration(provider);
  if (decl) return decl;
  ctx.addIssue({
    code: 'custom',
    path: ['provider'],
    message: undeclaredProviderMessage(provider),
  });
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

export const updateSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  /** A deploy binding's stages, correctable after the fact: a project that finds
   *  its stage topology wrong should not have to delete the binding, and its
   *  credential with it, to say so. */
  stages: stagesSchema.optional(),
  secrets: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
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

export function configSchemaForProvider(provider: string): z.ZodTypeAny {
  const decl = getIntegration(provider);
  if (!decl) throw badRequest(undeclaredProviderMessage(provider));
  return decl.schemas.patchConfig;
}

/** The config schema for an OWNER-SCOPED connection PATCH, where a binding-tier key does not belong. */
export function connectionConfigSchemaForProvider(provider: string): z.ZodTypeAny {
  const decl = getIntegration(provider);
  if (!decl) throw badRequest(undeclaredProviderMessage(provider));
  return decl.schemas.connectionConfig;
}

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
  const hasSecretInput = typeof incoming[primaryField] === 'string' || secondaryFields.length > 0;
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
