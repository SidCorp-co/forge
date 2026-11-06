// The owner's credential for a product, kept by core (ISS-1013, REQ-85 BC-2, BC-4): one per
// support-api binding, a project secret under `owner-acts`, sealed in the project's vault and
// written to its credential audit like every other secret. It is read only by the owner-act door,
// which sends it from core; no turn, brief, answer or box ever carries it. A project admin keeps it
// at its own door, which checks the binding and the shape before anything is stored: static
// headers, or the owner's OAuth tokens (ISS-1047), which core refreshes before an act
// (`owner-refresh.ts`) and which the owner's own sign-in also keeps (`owner-sign-in.ts`).

import { secretRefOf } from '@forge/contracts/project-config';
import {
  SUPPORT_OWNER_CREDENTIAL_SCOPE,
  type SupportOwnerCredential,
  type SupportOwnerSignIn,
  supportOwnerCredentialName,
  supportOwnerCredentialRequestSchema,
  supportOwnerCredentialSchema,
} from '@forge/contracts/support';
import type { Tx } from '../db/client.js';
import { credentialValuesOf, readSupportApis } from '../integrations/support-api/index.js';
import {
  deleteSecret,
  listSecretNames,
  readProjectSecrets,
  rewriteSecretAsCore,
  writeSecret,
} from '../project-config/index.js';
import { no, type Outcome } from './outcome.js';

/** Who keeps or drops the credential, as the credential audit names them. */
export interface CredentialActor {
  id: string;
  tokenId: string | null;
  agency: 'human' | 'agent';
}

const refOf = (bindingId: string) =>
  secretRefOf(SUPPORT_OWNER_CREDENTIAL_SCOPE, supportOwnerCredentialName(bindingId));

/** The project's product, by its support-api binding id: its name, or the refusal naming the ones it binds. */
async function productOf(
  projectId: string,
  bindingId: string,
): Promise<Outcome<{ bindingId: string; name: string; ownerSignIn: SupportOwnerSignIn | null }>> {
  const reads = await readSupportApis(projectId);
  const found = reads.find((r) => (r.ok ? r.api.bindingId : r.bindingId) === bindingId);
  if (found) {
    return {
      ok: true,
      value: found.ok
        ? { bindingId, name: found.api.name, ownerSignIn: found.api.ownerSignIn }
        : { bindingId, name: found.name, ownerSignIn: null },
    };
  }
  const names = reads.map(
    (r) => `${r.ok ? r.api.bindingId : r.bindingId} (${r.ok ? r.api.name : r.name})`,
  );
  return no(
    'SUPPORT_OWNER_PRODUCT_UNKNOWN',
    '/bindingId',
    `this project binds no product API (support-api) ${bindingId}; it binds ${names.join(', ') || 'none'}. Nothing was kept.`,
  );
}

export type KeepOutcome =
  | { ok: true; value: { bindingId: string; product: string; kept: true; updatedAt: string } }
  | { ok: false; refusals: { code: string; path: string; detail: string }[] }
  | { ok: false; code: 'VAULT_NOT_CONFIGURED' };

/** What the door keeps for a body it took: headers as they are, OAuth tokens with their expiry. */
function keptOf(
  body: (typeof supportOwnerCredentialRequestSchema)['_output'],
  now: number,
): SupportOwnerCredential {
  if ('headers' in body) return body;
  const { accessToken, refreshToken, expiresIn } = body.oauth;
  return {
    oauth: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: expiresIn ? new Date(now + expiresIn * 1000).toISOString() : null,
    },
  };
}

/**
 * Keep the owner's credential for one product, sealed: the headers core sends as him, or his OAuth
 * tokens. A refresh token is kept only where the binding declares how to spend it (`ownerSignIn`):
 * one stored where it never could be would be a credential nobody can use.
 */
export async function keepOwnerCredential(input: {
  projectId: string;
  bindingId: string;
  body: unknown;
  actor: CredentialActor;
}): Promise<KeepOutcome> {
  const product = await productOf(input.projectId, input.bindingId);
  if (!product.ok) return product;
  const parsed = supportOwnerCredentialRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return no(
      'SUPPORT_OWNER_CREDENTIAL_MISSING',
      '/headers',
      `the body is { "headers": { "<header name>": "<value>" } }, at most 10 headers, each name letters, digits and dashes; or { "oauth": { "accessToken", "refreshToken"?, "expiresIn"? } }: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}. Nothing was kept.`,
    );
  }
  if ('oauth' in parsed.data && parsed.data.oauth.refreshToken && !product.value.ownerSignIn) {
    return no(
      'SUPPORT_OWNER_SIGN_IN_UNDECLARED',
      '/oauth/refreshToken',
      `the support-api binding of ${product.value.name} declares no ownerSignIn { authorizationUrl, tokenUrl, clientId }, so a refresh token kept for it could never be spent; declare it on the binding first. Nothing was kept.`,
    );
  }
  const written = await writeSecret({
    projectId: input.projectId,
    scope: SUPPORT_OWNER_CREDENTIAL_SCOPE,
    name: supportOwnerCredentialName(input.bindingId),
    value: JSON.stringify(keptOf(parsed.data, Date.now())),
    actor: input.actor,
  });
  if (!written.ok) return written;
  return {
    ok: true,
    value: {
      bindingId: input.bindingId,
      product: product.value.name,
      kept: true,
      updatedAt: written.secret.updatedAt.toISOString(),
    },
  };
}

/** Drop the owner's credential for one product: the room cannot act as him there until one is kept again. */
export async function dropOwnerCredential(input: {
  projectId: string;
  bindingId: string;
  actor: CredentialActor;
}): Promise<Outcome<{ bindingId: string; dropped: boolean }>> {
  const out = await deleteSecret({
    projectId: input.projectId,
    scope: SUPPORT_OWNER_CREDENTIAL_SCOPE,
    name: supportOwnerCredentialName(input.bindingId),
    actor: input.actor,
  });
  if (out.ok) return { ok: true, value: { bindingId: input.bindingId, dropped: true } };
  if (out.notFound) return { ok: true, value: { bindingId: input.bindingId, dropped: false } };
  return {
    ok: false,
    refusals: out.refusals.map((r) => ({
      code: 'SUPPORT_OWNER_CREDENTIAL_MISSING' as const,
      path: r.path,
      detail: r.detail,
    })),
  };
}

/** Each product of the project, whether core keeps the owner's credential for it, and whether it ended: names, never values. */
export async function ownerCredentialsOf(projectId: string): Promise<
  {
    bindingId: string;
    product: string;
    kept: boolean;
    updatedAt: string | null;
    ended: { at: string; reason: string } | null;
  }[]
> {
  const [reads, secrets] = await Promise.all([
    readSupportApis(projectId),
    listSecretNames(projectId),
  ]);
  return Promise.all(
    reads.map(async (r) => {
      const bindingId = r.ok ? r.api.bindingId : r.bindingId;
      const held = secrets.find((s) => s.ref === refOf(bindingId));
      const read = held ? await readOwnerCredential(projectId, bindingId) : null;
      const ended = read?.ok && 'ended' in read.value ? read.value.ended : null;
      return {
        bindingId,
        product: r.ok ? r.api.name : r.name,
        // an ended credential holds no token: nothing is kept that the room could act with
        kept: Boolean(held) && !ended,
        updatedAt: held?.updatedAt.toISOString() ?? null,
        ended,
      };
    }),
  );
}

export type OwnerCredentialRead =
  | { ok: true; value: SupportOwnerCredential }
  | { ok: false; why: 'missing' | 'unreadable' | 'malformed' };

/** The credential core keeps for one product, as stored; or why there is none it can read. */
export async function readOwnerCredential(
  projectId: string,
  bindingId: string,
): Promise<OwnerCredentialRead> {
  const ref = refOf(bindingId);
  const read = await readProjectSecrets(projectId, [ref]);
  if (!read.ok) {
    return { ok: false, why: read.code === 'SECRET_VALUE_MISSING' ? 'missing' : 'unreadable' };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.values.get(ref) ?? '');
  } catch {
    value = null;
  }
  const parsed = supportOwnerCredentialSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, why: 'malformed' };
}

/**
 * Store what core made of the credential, inside the caller's transaction: the rotated OAuth pair
 * after a refresh, or the ended mark after a refused one. `why` goes to the credential audit.
 */
export async function rewriteOwnerCredential(
  tx: Tx,
  input: { projectId: string; bindingId: string; value: SupportOwnerCredential; why: string },
): Promise<void> {
  await rewriteSecretAsCore(tx, {
    projectId: input.projectId,
    scope: SUPPORT_OWNER_CREDENTIAL_SCOPE,
    name: supportOwnerCredentialName(input.bindingId),
    value: JSON.stringify(input.value),
    why: input.why,
  });
}

/** Every value one kept credential holds that must never be posted or recorded. */
export function ownerCredentialValuesOf(kept: SupportOwnerCredential): string[] {
  if ('headers' in kept) return credentialValuesOf(kept.headers);
  if ('oauth' in kept) {
    return [kept.oauth.accessToken, ...(kept.oauth.refreshToken ? [kept.oauth.refreshToken] : [])];
  }
  return [];
}

/**
 * Every value of every owner credential the project keeps, the access and the refresh token alike,
 * for scrubbing a line before it is posted or recorded: never a value read for any other use.
 */
export async function ownerSecretsOf(projectId: string): Promise<string[]> {
  const secrets = await listSecretNames(projectId);
  const refs = secrets.filter((s) => s.scope === SUPPORT_OWNER_CREDENTIAL_SCOPE).map((s) => s.ref);
  if (refs.length === 0) return [];
  const read = await readProjectSecrets(projectId, refs);
  if (!read.ok) return [];
  const values: string[] = [];
  for (const raw of read.values.values()) {
    let parsed: ReturnType<typeof supportOwnerCredentialSchema.safeParse> | null = null;
    try {
      parsed = supportOwnerCredentialSchema.safeParse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    // a value the door did not write is scrubbed whole
    if (parsed?.success) values.push(...ownerCredentialValuesOf(parsed.data));
    else values.push(raw);
  }
  return values;
}
