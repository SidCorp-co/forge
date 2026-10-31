// Asking a question as somebody through the REST door: on an issue, or on none with the project it
// is asked in and what it is about (FB-149).

import { randomUUID } from 'node:crypto';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { QuestionAboutRequest, QuestionRefusalCode } from '@forge/contracts/questions';
import type { Refusal } from '@forge/contracts/refusal';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { QuestionBlockerKind } from '../db/schema-questions.js';
import { RefusalError } from '../lib/refusal.js';
import { requireHeld } from '../permissions/index.js';
import { accessOn } from './read.js';
import { refuseStewardOptions } from './steward-options.js';
import { type AskAnswer, type AskInput, askQuestion } from './write.js';

/**
 * Ask a question, as somebody, or `null` when that somebody cannot reach the issue or project it is
 * asked in. Asked on an issue, it stands there; asked on none, it is about a requirement or a
 * contract (`about`) of `projectId`, listed on that requirement and answered from Needs you, its
 * answer a decision there (FB-149). The ask writes the question and nothing else: the issue keeps
 * its status, and an open `human` question is the marker that a person owes it an answer (ISS-1257).
 */
type AskAsInput = {
  userId: string;
  /** Who asks: an agent asking a person what it may decide itself is refused by name (REQ-79 BC-14). */
  agency: ActorAgency;
  serious?: boolean | undefined;
  issueId?: string | undefined;
  projectId?: string | undefined;
  prompt: string;
  blockerKind: QuestionBlockerKind;
  answer: AskAnswer;
  assumed?: Record<string, unknown> | undefined;
  maxRounds?: number | undefined;
  parkDeadlineAt?: Date | undefined;
  sensitive?: boolean | undefined;
  about?: QuestionAboutRequest | undefined;
};

/**
 * What an ask on no issue is missing, every gap at once: the project it is asked in, where `about`
 * resolves a REQ-n key, and the `about` itself, without which it would stand on nothing a person
 * reads it from. An ask on an issue owes neither.
 */
export function issuelessAskRefusals(input: {
  issueId?: string | undefined;
  projectId?: string | undefined;
  about?: unknown;
}): Array<Refusal & { code: QuestionRefusalCode }> {
  if (input.issueId) return [];
  const out: Array<Refusal & { code: QuestionRefusalCode }> = [];
  if (!input.projectId) {
    out.push({
      code: 'QUESTION_PROJECT_REQUIRED',
      path: '/projectId',
      detail:
        'a question asked on no issue names the project it is asked in: send `projectId`, or ask it on an issue with `issueId`',
    });
  }
  if (!input.about) {
    out.push({
      code: 'QUESTION_SUBJECT_REQUIRED',
      path: '/about',
      detail:
        'a question asked on no issue names what it is about: `about` {"requirement":"REQ-n"} or {"contract":"<project>/<contract>"}; or ask it on an issue with `issueId`',
    });
  }
  return out;
}

export async function askAs(args: AskAsInput) {
  refuseStewardOptions(args.answer);
  const gaps = issuelessAskRefusals(args);
  if (gaps.length) throw new RefusalError(gaps, 'QUESTION_REFUSED');
  const projectId = args.issueId
    ? (await readAskedIssue(args.issueId))?.projectId
    : (args.projectId as string);
  if (!projectId) return null;
  const access = await accessOn(projectId, args.userId);
  if (!access) return null;
  requireHeld(access, 'project.write', 'asking a question');
  const ask: AskInput = {
    id: randomUUID(),
    // an issue's own project; a projectId sent beside it that disagrees is refused QUESTION_ISSUE_ELSEWHERE
    projectId: args.projectId ?? projectId,
    ...(args.issueId ? { issueId: args.issueId } : {}),
    askedBy: args.userId,
    prompt: args.prompt,
    blockerKind: args.blockerKind,
    ...(args.serious ? { serious: true } : {}),
    ...(args.agency === 'agent' ? { askedByAgent: true as const } : {}),
    answer: args.answer,
    ...(args.assumed ? { assumed: args.assumed } : {}),
    ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
    ...(args.parkDeadlineAt ? { parkDeadlineAt: args.parkDeadlineAt } : {}),
    ...(args.sensitive ? { sensitive: true } : {}),
    ...(args.about ? { about: args.about } : {}),
  };
  return askQuestion(ask);
}

async function readAskedIssue(issueId: string) {
  const [issue] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issue;
}
