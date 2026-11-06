// The owner's credential for a product, kept by core (ISS-1013, REQ-85 BC-2, BC-4): one per
// support-api binding, a project secret under `owner-acts`, sealed in the project's vault and
// written to its credential audit like every other secret. It is read only by the owner-act door,
// which sends it from core; no turn, brief, answer or box ever carries it. A project admin keeps it
// at its own door, which checks the binding and the shape before anything is stored.

import { secretRefOf } from '@forge/contracts/project-config';
import {
  SUPPORT_OWNER_CREDENTIAL_SCOPE,
  supportApiSecretsSchema,
  supportOwnerCredentialName,
} from '@forge/contracts/support';
import { credentialValuesOf, readSupportApis } from '../integrations/support-api/index.js';
import {
  deleteSecret,
  listSecretNames,
  readProjectSecrets,
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
): Promise<Outcome<{ bindingId: string; name: string }>> {
  const reads = await readSupportApis(projectId);
  const found = reads.find((r) => (r.ok ? r.api.bindingId : r.bindingId) === bindingId);
  if (found)
    return { ok: true, value: { bindingId, name: found.ok ? found.api.name : found.name } };
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

/** Keep the owner's credential for one product: the headers core sends as him, sealed. */
export async function keepOwnerCredential(input: {
  projectId: string;
  bindingId: string;
  body: unknown;
  actor: CredentialActor;
}): Promise<KeepOutcome> {
  const product = await productOf(input.projectId, input.bindingId);
  if (!product.ok) return product;
  const parsed = supportApiSecretsSchema.safeParse(input.body);
  if (!parsed.success) {
    return no(
      'SUPPORT_OWNER_CREDENTIAL_MISSING',
      '/headers',
      `the body is { "headers": { "<header name>": "<value>" } }, at most 10 headers, each name letters, digits and dashes: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}. Nothing was kept.`,
    );
  }
  const written = await writeSecret({
    projectId: input.projectId,
    scope: SUPPORT_OWNER_CREDENTIAL_SCOPE,
    name: supportOwnerCredentialName(input.bindingId),
    value: JSON.stringify(parsed.data),
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

/** Each product of the project, and whether core keeps the owner's credential for it: names, never values. */
export async function ownerCredentialsOf(
  projectId: string,
): Promise<{ bindingId: string; product: string; kept: boolean; updatedAt: string | null }[]> {
  const [reads, secrets] = await Promise.all([
    readSupportApis(projectId),
    listSecretNames(projectId),
  ]);
  return reads.map((r) => {
    const bindingId = r.ok ? r.api.bindingId : r.bindingId;
    const held = secrets.find((s) => s.ref === refOf(bindingId));
    return {
      bindingId,
      product: r.ok ? r.api.name : r.name,
      kept: Boolean(held),
      updatedAt: held?.updatedAt.toISOString() ?? null,
    };
  });
}

/**
 * The owner's headers for one product, read for the one call core makes with them; or the refusal
 * naming why there are none. Only the owner-act door calls this.
 */
export async function ownerHeadersOf(
  projectId: string,
  bindingId: string,
  product: string,
  keeper: string,
): Promise<Outcome<Record<string, string>>> {
  const ref = refOf(bindingId);
  const read = await readProjectSecrets(projectId, [ref]);
  const missing = (why: string) =>
    no<Record<string, string>>(
      'SUPPORT_OWNER_CREDENTIAL_MISSING',
      '/tool',
      `${why}, so nothing was sent to ${product}. To keep it, ${keeper} at PUT /api/projects/${projectId}/support/owner-credentials/${bindingId}.`,
    );
  if (!read.ok) {
    return missing(
      read.code === 'SECRET_VALUE_MISSING'
        ? `Forge keeps no owner credential for ${product}`
        : `the owner credential Forge keeps for ${product} cannot be opened with this core's vault key`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(read.values.get(ref) ?? '');
  } catch {
    value = null;
  }
  const parsed = supportApiSecretsSchema.safeParse(value);
  if (!parsed.success) {
    return missing(
      `the owner credential Forge keeps for ${product} is not { headers } as the door writes it`,
    );
  }
  return { ok: true, value: parsed.data.headers };
}

/**
 * Every value of every owner credential the project keeps, for scrubbing a line before it is posted
 * or recorded: never a value read for any other use.
 */
export async function ownerSecretsOf(projectId: string): Promise<string[]> {
  const kept = (await ownerCredentialsOf(projectId)).filter((c) => c.kept);
  if (kept.length === 0) return [];
  const refs = kept.map((c) => refOf(c.bindingId));
  const read = await readProjectSecrets(projectId, refs);
  if (!read.ok) return [];
  const values: string[] = [];
  for (const raw of read.values.values()) {
    try {
      const parsed = supportApiSecretsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) values.push(...credentialValuesOf(parsed.data.headers));
    } catch {
      // a value the door did not write is scrubbed whole
      values.push(raw);
    }
  }
  return values;
}
