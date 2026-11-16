// A decision's module (ISS-1256): a decision comment belongs to one business module, set by the module
// map's placement door. Only a decision carries one (`comments_module_chk`).

import type { ModuleMapRefusalCode } from '@forge/contracts/module-map';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<ModuleMapRefusalCode>('MODULE_MAP_REFUSED');

/**
 * Set decision `commentId`'s module; the module it had before, or undefined where no comment is
 * `commentId`. A comment that is not a decision is refused `MODULE_MAP_KIND_MISMATCH`. The caller has
 * checked the comment is of the project (`decisionIn`).
 */
export async function setDecisionModule(
  commentId: string,
  moduleId: string | null,
): Promise<string | null | undefined> {
  const [before] = await db
    .select({ moduleId: comments.moduleId, intent: comments.intent })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!before) return undefined;
  if (before.intent !== 'decision') {
    throw refuse(
      'MODULE_MAP_KIND_MISMATCH',
      `comment ${commentId} is a ${before.intent}, not a decision: only a decision is placed in a module`,
      '/ref',
    );
  }
  await db.update(comments).set({ moduleId }).where(eq(comments.id, commentId));
  return before.moduleId;
}
