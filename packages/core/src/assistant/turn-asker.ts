// Who asks a Forge UI turn, as a persona names them, and the language a code-written line answers them in.

import { confidentLanguageOf, languageOfTag, type ReplyLanguage } from '../conversations/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { readContentLanguage } from '../project-config/index.js';
import type { WebTurnArgs } from './web-turn-args.js';

/** What a turn answers in, and who said so: the project's content language, or a guess at the question's. */
export interface AnswerLanguage {
  language: ReplyLanguage;
  by: 'project' | 'guess';
}

/**
 * The language a turn is asked to answer in (ISS-1451, ISS-1442, owner direction): the project's
 * content language where its document declares one; only for a project that never said, the language
 * the question is CONFIDENTLY written in, as a hint; else none. It is told to the turn and never held
 * against the reply: three rounds tuned the guess as a refusal and failed live (FB-841, FB-852, FB-853).
 */
export async function answerLanguageOf(
  projectId: string,
  question: string | null | undefined,
): Promise<AnswerLanguage | null> {
  const setting = await readContentLanguage(projectId);
  if (setting.source === 'document') {
    return { language: languageOfTag(setting.contentLanguage), by: 'project' };
  }
  const guessed = confidentLanguageOf(question);
  return guessed ? { language: guessed, by: 'guess' } : null;
}

/**
 * The language a code-written line answers in: `answerLanguageOf`, else English, the default of a
 * project that never said. A short question with no Vietnamese letter ("ok", "chay ISS-5") is not
 * taken for English by the guess; it falls to the project's default.
 */
export async function askerLineLanguage(args: WebTurnArgs): Promise<ReplyLanguage> {
  return (await answerLanguageOf(args.project.id, args.window.question))?.language ?? 'en';
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
