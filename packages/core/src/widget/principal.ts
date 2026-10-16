// The account a widget binding files Feedback as. One per binding, minted the first time the
// binding files: an agent-kind user that is a member of no project and no organisation, so it holds
// no role, no grant and no token, and every read route refuses it. It names the reporter on the
// Feedback row, because that column names a user and a visitor is never one.

import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import { insertPrincipal, principalOf } from './store.js';

/** The label the account is read by on the items it files. */
const principalLabel = (title: string | undefined) =>
  `Site visitor via ${title?.trim() || 'the feedback widget'}`;

export async function widgetPrincipalFor(binding: {
  bindingId: string;
  projectId: string;
  title?: string | undefined;
}): Promise<string> {
  const held = await principalOf(db, binding.bindingId);
  if (held) return held;
  const minted = await db.transaction(async (tx) => {
    await lockXact(tx, 'widgetPrincipal', binding.bindingId);
    const raced = await principalOf(tx, binding.bindingId);
    if (raced) return { userId: raced, created: false };
    const account = await insertAgentAccount(tx, `widget-${binding.bindingId.slice(0, 8)}`);
    await insertPrincipal(tx, {
      bindingId: binding.bindingId,
      projectId: binding.projectId,
      userId: account.id,
    });
    return { userId: account.id, created: true };
  });
  if (minted.created) await setUserDisplayName(minted.userId, principalLabel(binding.title));
  return minted.userId;
}
