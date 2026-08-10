/**
 * Org-scoped Private Keys pool (ISS-628) — the shared service layer behind
 * `orgs/ssh-keys-routes.ts`. Kept as a standalone module (not inlined in the
 * route handlers) so the safe-delete guard is enforced server-side ONCE and
 * can never be bypassed by a second write path — Coolify shipped a UI-only
 * in-use guard and had to patch the API after the fact (coollabsio/coolify
 * #5524); this project does the DB-level guard (FK ON DELETE RESTRICT) plus
 * this service-level pre-check (for a friendly 409 instead of a raw
 * constraint-violation 500).
 *
 * Listing/showing a key never selects `privateKeyEnc` — decrypt only happens
 * in `testOrgSshKey` (connection probe) and at device provisioning
 * (`devices/routes.ts`).
 */
import { HTTPException } from 'hono/http-exception';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  projectGitCredentials,
  projects,
  workspaceSshKeys,
  type ProjectGitCredentialSource,
} from '../db/schema.js';
import { derivePublicFromPrivate, generateSshKeypair, testSshConnection } from '../git/ssh-keys.js';
import { assertSafeSshRepoUrl } from '../git/ssh-host-guard.js';
import { decryptSecret, encryptSecret, isVaultConfigured } from '../integrations/vault.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import type { SshConnTestResult, SshKeyCreateInput, WorkspaceSshKeyView } from '@forge/contracts';

const vaultUnavailable = () =>
  new HTTPException(503, {
    message: 'secret vault not configured (INTEGRATION_MASTER_KEY missing)',
    cause: { code: 'VAULT_NOT_CONFIGURED' },
  });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

type KeyRow = {
  id: string;
  orgId: string;
  name: string;
  note: string | null;
  source: string;
  keyType: string;
  publicKey: string;
  fingerprint: string | null;
  createdAt: Date;
};

/** Every project (id/slug/name) currently referencing the given pool keys. */
async function usedByForKeys(keyIds: string[]): Promise<Map<string, WorkspaceSshKeyView['usedByProjects']>> {
  const usedBy = new Map<string, WorkspaceSshKeyView['usedByProjects']>();
  if (keyIds.length === 0) return usedBy;
  const rows = await db
    .select({
      sshKeyId: projectGitCredentials.sshKeyId,
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(projectGitCredentials)
    .innerJoin(projects, eq(projects.id, projectGitCredentials.projectId))
    .where(inArray(projectGitCredentials.sshKeyId, keyIds));
  for (const r of rows) {
    const list = usedBy.get(r.sshKeyId) ?? [];
    list.push({ id: r.id, slug: r.slug, name: r.name });
    usedBy.set(r.sshKeyId, list);
  }
  return usedBy;
}

function toView(row: KeyRow, usedByProjects: WorkspaceSshKeyView['usedByProjects']): WorkspaceSshKeyView {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    note: row.note,
    source: row.source as ProjectGitCredentialSource,
    keyType: row.keyType as WorkspaceSshKeyView['keyType'],
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
    usedByProjects,
  };
}

const NON_SECRET_COLUMNS = {
  id: workspaceSshKeys.id,
  orgId: workspaceSshKeys.orgId,
  name: workspaceSshKeys.name,
  note: workspaceSshKeys.note,
  source: workspaceSshKeys.source,
  keyType: workspaceSshKeys.keyType,
  publicKey: workspaceSshKeys.publicKey,
  fingerprint: workspaceSshKeys.fingerprint,
  createdAt: workspaceSshKeys.createdAt,
} as const;

/** List every pool key in an org (non-secret view + usedBy projects). */
export async function listOrgSshKeys(orgId: string): Promise<WorkspaceSshKeyView[]> {
  const rows = await db
    .select(NON_SECRET_COLUMNS)
    .from(workspaceSshKeys)
    .where(eq(workspaceSshKeys.orgId, orgId));
  const usedBy = await usedByForKeys(rows.map((r) => r.id));
  return rows.map((r) => toView(r, usedBy.get(r.id) ?? []));
}

/** Fetch one pool key's non-secret view, or null. */
export async function getOrgSshKey(orgId: string, keyId: string): Promise<WorkspaceSshKeyView | null> {
  const [row] = await db
    .select(NON_SECRET_COLUMNS)
    .from(workspaceSshKeys)
    .where(and(eq(workspaceSshKeys.id, keyId), eq(workspaceSshKeys.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  const usedBy = await usedByForKeys([row.id]);
  return toView(row, usedBy.get(row.id) ?? []);
}

/**
 * Create (generate or paste) a pool key. Throws 503 when the vault isn't
 * configured, 400 `INVALID_PRIVATE_KEY` on a malformed/passphrase-protected
 * paste, and 409 `DUPLICATE_FINGERPRINT` when the physical key already exists
 * in this org (the partial unique index on `(org_id, fingerprint)`).
 */
export async function createOrgSshKey(
  orgId: string,
  userId: string,
  input: SshKeyCreateInput,
): Promise<WorkspaceSshKeyView> {
  if (!isVaultConfigured()) throw vaultUnavailable();

  const comment = `forge-${input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'key'}`;
  let keypair: { publicKey: string; privateKey: string; fingerprint: string | null };
  let source: ProjectGitCredentialSource;
  try {
    if (input.mode === 'generate') {
      keypair = await generateSshKeypair(comment);
      source = 'forge_generated';
    } else {
      keypair = await derivePublicFromPrivate(input.privateKey, comment);
      source = 'user_provided';
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith('invalid_private_key')) {
      throw new HTTPException(400, { message: msg, cause: { code: 'INVALID_PRIVATE_KEY' } });
    }
    logger.error({ err, orgId }, 'ssh-keys: keypair build failed');
    throw new HTTPException(500, {
      message: 'failed to build SSH keypair',
      cause: { code: 'KEYPAIR_FAILED' },
    });
  }

  const privateKeyEnc = encryptSecret(keypair.privateKey);
  try {
    const [row] = await db
      .insert(workspaceSshKeys)
      .values({
        orgId,
        name: input.name.trim(),
        note: input.note?.trim() || null,
        source,
        keyType: 'ed25519',
        publicKey: keypair.publicKey,
        privateKeyEnc,
        fingerprint: keypair.fingerprint,
        createdBy: userId,
      })
      .returning(NON_SECRET_COLUMNS);
    if (!row) {
      throw new HTTPException(500, {
        message: 'ssh key insert returned no row',
        cause: { code: 'INSERT_FAILED' },
      });
    }
    logger.info({ orgId, source }, 'ssh-keys: created pool key');
    return toView(row, []);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, {
        message: 'this key already exists in the org pool (matching fingerprint)',
        cause: { code: 'DUPLICATE_FINGERPRINT' },
      });
    }
    throw err;
  }
}

/**
 * Safe-delete: throws 409 with the referencing-project list when the key is
 * still in use by any project. Deleting an unreferenced key is a hard delete
 * (the FK's ON DELETE RESTRICT would also block an in-use delete at the DB
 * level — this pre-check exists only to surface a friendly structured error
 * instead of a raw constraint-violation 500).
 */
export async function deleteOrgSshKey(orgId: string, keyId: string): Promise<void> {
  const [row] = await db
    .select({ id: workspaceSshKeys.id })
    .from(workspaceSshKeys)
    .where(and(eq(workspaceSshKeys.id, keyId), eq(workspaceSshKeys.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound('ssh key not found');

  const usedBy = await usedByForKeys([keyId]);
  const referencedBy = usedBy.get(keyId) ?? [];
  if (referencedBy.length > 0) {
    throw new HTTPException(409, {
      message: 'this key is in use by one or more projects',
      cause: { code: 'KEY_IN_USE', details: { referencedBy } },
    });
  }

  await db.delete(workspaceSshKeys).where(eq(workspaceSshKeys.id, keyId));
}

/**
 * Decrypt + probe a pool key's reachability against `repoUrl` (git ls-remote).
 * `repoUrl` is caller-supplied (the member is testing a key against a repo
 * they're about to attach it to), so it's validated to an SSH-form remote
 * resolving to a public host before it ever reaches `testSshConnection` —
 * see `git/ssh-host-guard.ts` for why (RCE via `ext::`, SSRF via a private
 * host).
 */
export async function testOrgSshKey(
  orgId: string,
  keyId: string,
  repoUrl: string,
): Promise<SshConnTestResult> {
  await assertSafeSshRepoUrl(repoUrl);
  if (!isVaultConfigured()) throw vaultUnavailable();

  const [row] = await db
    .select({ privateKeyEnc: workspaceSshKeys.privateKeyEnc })
    .from(workspaceSshKeys)
    .where(and(eq(workspaceSshKeys.id, keyId), eq(workspaceSshKeys.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound('ssh key not found');

  let privateKey: string;
  try {
    privateKey = decryptSecret(row.privateKeyEnc);
  } catch (err) {
    logger.error({ err, orgId, keyId }, 'ssh-keys: decrypt failed on connection test');
    throw new HTTPException(500, {
      message: 'failed to decrypt the stored key (vault master key may have rotated)',
      cause: { code: 'DECRYPT_FAILED' },
    });
  }

  return testSshConnection(repoUrl, privateKey);
}
