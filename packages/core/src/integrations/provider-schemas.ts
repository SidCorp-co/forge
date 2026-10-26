import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { fieldsNamedAt } from '../lib/unknown-fields.js';
import { fieldsNear, schemaRefusalWords } from '../lib/zod-sentences.js';
import { AGENT_ACCESS_VALUES } from './agent-access.js';
import { bindingShapeFields, checkBindingShape, stagesSchema } from './binding-shape.js';
import { CredentialUnreadable, SEND_WHOLE } from './credential-unreadable.js';
import { providerLabel } from './health-words.js';
import { getIntegration, providerNames } from './registry.js';
import { mergeRotatedSecrets } from './rotation.js';
import { assertVaultConfigured, badRequest } from './route-helpers.js';
import type { IntegrationConnectionRow } from './store.js';
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

/**
 * A provider schema's issues said under `key`, each stray field one issue of its own that names
 * the fields near it the provider takes (ISS-1421 r18): the envelope's `config` is a record, so
 * the route's own schema cannot say what a field inside it may have meant.
 */
function issuesUnder(
  schema: z.ZodTypeAny,
  issues: readonly z.core.$ZodIssue[],
  key: 'config' | 'secrets',
): z.core.$ZodIssue[] {
  return issues.flatMap((issue): z.core.$ZodIssue[] => {
    const path = [key, ...issue.path];
    if (issue.code !== 'unrecognized_keys') return [{ ...issue, path }];
    const known = fieldsNamedAt(schema, issue.path);
    const full = (k: string) => [...path, k].map(String).join('.');
    return issue.keys.map((stray) => {
      const near = fieldsNear(stray, known).map(full);
      const meant =
        near.length === 0
          ? ''
          : ` This call takes ${near.join(' and ')}, ${near.length === 1 ? 'which' : 'either of which'} may be what ${full(stray)} meant.`;
      return {
        code: 'custom',
        path: [...path, stray],
        message: `is not one this call takes.${meant}`,
        input: undefined,
      } as z.core.$ZodIssue;
    });
  });
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
  for (const issue of issuesUnder(schema, parsed.error.issues, key)) ctx.addIssue(issue as never);
  return undefined;
}

/** A provider half parsed, or refused by `providerHalfRefused`. */
export function parseProviderHalf(
  schema: z.ZodTypeAny,
  sent: unknown,
  key: 'config' | 'secrets',
): Record<string, unknown> {
  const parsed = schema.safeParse(sent);
  if (!parsed.success) throw providerHalfRefused(parsed.error, schema, key, sent);
  return parsed.data as Record<string, unknown>;
}

/** A binding PATCH's config against the provider's partial schema. */
export function bindingConfigPatch(provider: string, sent: unknown): Record<string, unknown> {
  return parseProviderHalf(configSchemaForProvider(provider), sent, 'config');
}

/** A PATCH's provider half refused, in the sentences the create door says it in. */
export function providerHalfRefused(
  error: z.core.$ZodError,
  schema: z.ZodTypeAny,
  key: 'config' | 'secrets',
  sent: unknown,
): HTTPException {
  const issues = issuesUnder(schema, error.issues, key);
  const { sentences, accepted } = schemaRefusalWords(issues, {
    valuesAre: 'listed in details.accepted',
    input: { [key]: sent },
  });
  const listed = accepted.length > 0;
  return new HTTPException(400, {
    message: sentences.join(' '),
    cause: {
      code: 'BAD_REQUEST',
      details: {
        issues: issues.map(({ path, message }) => ({ path, message })),
        ...(listed
          ? { accepted: Object.fromEntries(accepted.map((a) => [a.field, a.values])) }
          : {}),
      },
    },
  });
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
    secrets: z.record(z.string(), z.unknown()).optional(),
    orgId: z.uuid().optional(),
    label: z
      .string()
      .min(1)
      .max(60)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        'A label takes lowercase letters, numbers and dashes, starting with a letter or number, e.g. partner-a.',
      )
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
    if (refuseKeyToKeyless(decl, value.secrets, ctx)) return z.NEVER;
    const config = parseInto(decl.schemas.bindingConfig, value.config, 'config', ctx);
    const secrets = parseInto(decl.schemas.secrets, value.secrets ?? {}, 'secrets', ctx);
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
    secrets: z.record(z.string(), z.unknown()).optional(),
    orgId: z.uuid().optional(),
  })
  .transform((value, ctx) => {
    const decl = declarationOrIssue(value.provider, ctx);
    if (!decl) return z.NEVER;
    if (refuseKeyToKeyless(decl, value.secrets, ctx)) return z.NEVER;
    const config = parseInto(decl.schemas.connectionConfig, value.config, 'config', ctx);
    const secrets = parseInto(decl.schemas.secrets, value.secrets ?? {}, 'secrets', ctx);
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

/** An OWNER-SCOPED connection PATCH: the provider's own partial, not its create schema — coolify
 *  splits its required `targets` to the binding tier, so no coolify connection took one (ISS-1275). */
export function connectionConfigSchemaForProvider(provider: string): z.ZodTypeAny {
  const decl = getIntegration(provider);
  if (!decl) throw badRequest(undeclaredProviderMessage(provider));
  return decl.schemas.connectionPatchConfig;
}

/**
 * The secrets a patch merges over, or `null` where none are stored. A stored credential this
 * server's key cannot open has nothing to merge with: a patch carrying the whole credential
 * replaces it (`'replaced'`), and one carrying part of it is refused, since the rest is lost.
 */
async function storedSecretsOrWhole(
  decl: IntegrationDeclaration,
  connection: IntegrationConnectionRow,
  incoming: Record<string, unknown>,
  bindingId: string | undefined,
): Promise<Record<string, unknown> | null | 'replaced'> {
  if (!connection.secretsEnc) return null;
  const { decryptConnectionSecrets } = await import('./store.js');
  try {
    return decryptConnectionSecrets(connection, bindingId ?? null);
  } catch (err) {
    if (!(err instanceof CredentialUnreadable)) throw err;
    if (decl.schemas.secrets.safeParse(incoming).success) return 'replaced';
    throw new CredentialUnreadable(err.credential, SEND_WHOLE);
  }
}

/**
 * A key sent to a provider that keeps none, which was once answered 200 and saved nowhere. One
 * sentence for every door, the creates' schema refusal included, so it opens "This " and is kept
 * whole there (ISS-1421 r29).
 */
export function noKeyToSaveMessage(provider: string): string {
  return `This is the ${providerLabel(provider)} integration, which keeps no key or secret, so there is nothing for one to be saved to. Send the write without one.`;
}

/** A share binds a connection that holds its own key, so a key sent with one is refused, never dropped. */
export const SHARE_TAKES_NO_KEY =
  'This shares a connection that already holds its own key, so a share carries none: whoever may manage the connection changes its key on the connection itself. Send the share without one.';

export function noKeyToSave(provider: string): HTTPException {
  return badRequest(noKeyToSaveMessage(provider));
}

/** Keys sent to a create for a provider that keeps none, an empty set of them included. */
function refuseKeyToKeyless(
  decl: IntegrationDeclaration,
  secrets: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx,
): boolean {
  if (decl.schemas.primaryCredentialField || secrets === undefined) return false;
  ctx.addIssue({ code: 'custom', path: ['secrets'], message: noKeyToSaveMessage(decl.provider) });
  return true;
}

export async function applySecretsPatch(opts: {
  provider: string;
  rawSecrets: Record<string, unknown>;
  connection: IntegrationConnectionRow;
  /** The binding the patch arrived through, named in a refusal; absent at the connection's own door. */
  bindingId?: string;
  vaultGuardTiming: 'before-parse' | 'on-secret-input';
}): Promise<Record<string, unknown> | undefined> {
  const decl = getIntegration(opts.provider);
  const primaryField = decl?.schemas.primaryCredentialField;
  if (!decl) return undefined;
  // Sent at all is refused: an empty set of keys was once answered 200 (ISS-1421 r29).
  if (!primaryField) throw noKeyToSave(opts.provider);
  if (opts.vaultGuardTiming === 'before-parse') assertVaultConfigured();
  const parsedSecrets = decl.schemas.patchSecrets.safeParse(opts.rawSecrets);
  if (!parsedSecrets.success)
    throw providerHalfRefused(
      parsedSecrets.error,
      decl.schemas.patchSecrets,
      'secrets',
      opts.rawSecrets,
    );
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
  const currentSecrets = await storedSecretsOrWhole(
    decl,
    opts.connection,
    incoming,
    opts.bindingId,
  );
  if (currentSecrets === 'replaced') return incoming;
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
