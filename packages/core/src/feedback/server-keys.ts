/**
 * A product server's key to file Feedback into its one project (ISS-922): mint, list, revoke, and
 * the read the filing door resolves a presented secret with. The secret is 256 random bits shown
 * once and kept as its SHA-256, as a widget session token is (`widget/tokens.ts`). Every key of one
 * product in a project names the same agent account, which the items it files record as their
 * reporter: a member of nothing, so it holds no permission and opens no session.
 */

import { randomBytes } from 'node:crypto';
import type {
  FeedbackServerKeyRefusalCode,
  FeedbackServerKeyView,
} from '@forge/contracts/feedback-server-keys';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import { feedbackServerKeys } from '../db/schema-feedback-server-keys.js';
import { lockXact } from '../lib/advisory-lock.js';
import { userNames } from '../lib/people.js';
import { type Refusal, refuser } from '../lib/refusal.js';
import { expiryRefusal, mintServerKeySecret, serverKeyHashOf } from './server-key-rules.js';

type KeyRow = typeof feedbackServerKeys.$inferSelect;

export { serverKeyClosed } from './server-key-rules.js';

const refuse = refuser<FeedbackServerKeyRefusalCode>('FEEDBACK_SERVER_KEY_REFUSED');

function viewOf(row: KeyRow, names: Map<string, string>): FeedbackServerKeyView {
  return {
    id: row.id,
    product: row.product,
    prefix: row.prefix,
    createdBy: row.createdBy ? { id: row.createdBy, name: names.get(row.createdBy) ?? null } : null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

async function viewsOf(rows: readonly KeyRow[]): Promise<FeedbackServerKeyView[]> {
  const names = await userNames(rows.map((r) => r.createdBy));
  return rows.map((r) => viewOf(r, names));
}

/**
 * Mint a key for `product` on the project. The product's account is the one an earlier key of the
 * same product holds, so revoking and re-minting keeps one reporter; the first key mints it.
 */
export async function mintServerKey(input: {
  projectId: string;
  product: string;
  expiresAt: Date | null;
  mintedBy: string;
  now?: Date;
}): Promise<
  { ok: true; key: FeedbackServerKeyView; secret: string } | { ok: false; refusals: Refusal[] }
> {
  const product = input.product.trim();
  const late = expiryRefusal(input.expiresAt, input.now ?? new Date());
  if (late) return { ok: false, refusals: [late] };
  const minted = mintServerKeySecret();
  const { row, newAccount } = await db.transaction(async (tx) => {
    await lockXact(tx, 'feedbackServerKey', input.projectId);
    const [held] = await tx
      .select({ accountId: feedbackServerKeys.accountId })
      .from(feedbackServerKeys)
      .where(
        and(
          eq(feedbackServerKeys.projectId, input.projectId),
          eq(feedbackServerKeys.product, product),
        ),
      )
      .limit(1);
    const accountId =
      held?.accountId ??
      (await insertAgentAccount(tx, `product-${randomBytes(4).toString('hex')}`)).id;
    const [inserted] = await tx
      .insert(feedbackServerKeys)
      .values({
        projectId: input.projectId,
        product,
        accountId,
        tokenHash: minted.hash,
        prefix: minted.prefix,
        createdBy: input.mintedBy,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!inserted) throw new Error('feedback server key: the insert returned no row');
    return { row: inserted, newAccount: !held };
  });
  if (newAccount) await setUserDisplayName(row.accountId, product);
  const [view] = await viewsOf([row]);
  if (!view) throw new Error('feedback server key: no view of the row just minted');
  return { ok: true, key: view, secret: minted.secret };
}

/** Every key of the project, newest first, revoked and expired ones included. Never a secret. */
export async function listServerKeys(projectId: string): Promise<FeedbackServerKeyView[]> {
  const rows = await db
    .select()
    .from(feedbackServerKeys)
    .where(eq(feedbackServerKeys.projectId, projectId))
    .orderBy(desc(feedbackServerKeys.createdAt));
  return viewsOf(rows);
}

/** Revoke one key of the project: it admits nothing from now on. */
export async function revokeServerKey(input: {
  projectId: string;
  keyId: string;
  revokedBy: string;
}): Promise<FeedbackServerKeyView> {
  const [row] = await db
    .select()
    .from(feedbackServerKeys)
    .where(
      and(
        eq(feedbackServerKeys.id, input.keyId),
        eq(feedbackServerKeys.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!row) {
    throw refuse(
      'FEEDBACK_SERVER_KEY_NOT_FOUND',
      `no server key ${input.keyId} on this project; GET …/feedback/server-keys lists them`,
      '/keyId',
    );
  }
  if (row.revokedAt) {
    throw refuse(
      'FEEDBACK_SERVER_KEY_REVOKED_ALREADY',
      `server key ${row.prefix}… was revoked at ${row.revokedAt.toISOString()}`,
      '/keyId',
    );
  }
  const [revoked] = await db
    .update(feedbackServerKeys)
    .set({ revokedAt: new Date(), revokedBy: input.revokedBy })
    .where(eq(feedbackServerKeys.id, row.id))
    .returning();
  const [view] = await viewsOf([revoked ?? row]);
  if (!view) throw new Error('feedback server key: no view of the row just revoked');
  return view;
}

/** The key a presented secret names, revoked or expired ones included; null where none does. */
export async function serverKeyOf(token: string): Promise<KeyRow | null> {
  const hash = serverKeyHashOf(token);
  if (!hash) return null;
  const [row] = await db
    .select()
    .from(feedbackServerKeys)
    .where(eq(feedbackServerKeys.tokenHash, hash))
    .limit(1);
  return row ?? null;
}

export async function touchServerKey(keyId: string, at: Date): Promise<void> {
  await db
    .update(feedbackServerKeys)
    .set({ lastUsedAt: at })
    .where(eq(feedbackServerKeys.id, keyId));
}

/** The product each of these accounts files for, where it is a server key's account. */
export async function productsOfAccounts(
  accountIds: readonly string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .selectDistinct({
      accountId: feedbackServerKeys.accountId,
      product: feedbackServerKeys.product,
    })
    .from(feedbackServerKeys)
    .where(inArray(feedbackServerKeys.accountId, [...accountIds]));
  return new Map(rows.map((r) => [r.accountId, r.product]));
}
