// Who asks a Forge UI turn, as a persona names them, and the language a code-written line answers them in.

import { askerLanguageOf, languageOfTag, type ReplyLanguage } from '../conversations/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { readContentLanguage } from '../project-config/index.js';
import type { WebTurnArgs } from './web-turn-args.js';

/**
 * The language a code-written line answers in: the question's where it can be told, else the
 * project's content language. A short question with no Vietnamese letter ("ok", "chay ISS-5") is
 * not taken for English.
 */
export async function askerLineLanguage(args: WebTurnArgs): Promise<ReplyLanguage> {
  return (
    askerLanguageOf(args.window.question) ??
    languageOfTag((await readContentLanguage(args.project.id)).contentLanguage)
  );
}

/**
 * The asker as the persona names them, with the role they hold on this project, so routing a change
 * wish reads who shapes the product (REQ-30 BC-3): an org owner or admin, or a project admin, shapes
 * it; a member or viewer reports to it.
 */
export async function askerWithRole(
  projectId: string,
  userId: string | null,
  askedBy: string | null,
): Promise<string | null> {
  if (!askedBy || !userId) return askedBy;
  const access = await effectiveProjectRole(userId, projectId);
  const role =
    access?.orgRole === 'owner' || access?.orgRole === 'admin'
      ? `org ${access.orgRole}, shapes the product`
      : access?.role === 'admin'
        ? 'project admin, shapes the product'
        : access?.role
          ? `project ${access.role}`
          : null;
  return role ? `${askedBy} (${role})` : askedBy;
}
