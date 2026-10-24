// What a question is about, as a person reads it (`subject`): the stored `about` resolved to the key
// and title every reader names it by, so the person answering never has to ask which requirement a
// business question concerns (ISS-583). One statement per kind for a page of rows.

import type { QuestionAbout, QuestionSubject } from '@forge/contracts/questions';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { requirements } from '../db/schema-requirements.js';

type Reader = Pick<Tx, 'select'>;

/** Each `about`, in order, as the subject a read names it by; null where a row names none. */
export async function subjectsOf(
  abouts: ReadonlyArray<QuestionAbout | null | undefined>,
  reader: Reader = db,
): Promise<Array<QuestionSubject | null>> {
  const requirementIds = [
    ...new Set(abouts.flatMap((a) => (a?.kind === 'requirement' ? [a.requirementId] : []))),
  ];
  const feedbackIds = [
    ...new Set(abouts.flatMap((a) => (a?.kind === 'feedback' ? [a.feedbackId] : []))),
  ];
  const reqs = new Map<string, { key: string; title: string }>();
  if (requirementIds.length > 0) {
    const found = await reader
      .select({ id: requirements.id, seq: requirements.reqSeq, title: requirements.title })
      .from(requirements)
      .where(inArray(requirements.id, requirementIds));
    for (const r of found) reqs.set(r.id, { key: `REQ-${r.seq}`, title: r.title });
  }
  const items = new Map<string, { key: string; title: string }>();
  if (feedbackIds.length > 0) {
    const found = await reader
      .select({ id: feedback.id, seq: feedback.fbSeq, title: feedback.title })
      .from(feedback)
      .where(inArray(feedback.id, feedbackIds));
    for (const f of found) items.set(f.id, { key: `FB-${f.seq}`, title: f.title });
  }
  return abouts.map((a): QuestionSubject | null => {
    if (!a) return null;
    if (a.kind === 'contract') return { kind: 'contract', key: a.contract };
    const named = a.kind === 'requirement' ? reqs.get(a.requirementId) : items.get(a.feedbackId);
    // nothing deletes a requirement or a feedback item but its project, which takes the question with
    // it, so one gone from under an about is a broken row, said by name rather than read as none
    if (!named) {
      throw new Error(
        `questions: an about names ${a.kind} ${a.kind === 'requirement' ? a.requirementId : a.feedbackId}, which no longer exists`,
      );
    }
    return { kind: a.kind, ...named };
  });
}

/** Each row with `subject`: what it is about, as a person reads it. */
export async function withSubject<T extends { about: QuestionAbout | null }>(
  rows: T[],
  reader: Reader = db,
): Promise<Array<T & { subject: QuestionSubject | null }>> {
  const subjects = await subjectsOf(
    rows.map((r) => r.about),
    reader,
  );
  return rows.map((r, i) => ({ ...r, subject: subjects[i] ?? null }));
}

/**
 * What the open questions a person owes on an issue are about, each named once, oldest first: the
 * park read shows it beside the questions it waits on (ISS-583).
 */
export async function openQuestionSubjectsOn(
  issueId: string,
  reader: Reader = db,
): Promise<QuestionSubject[]> {
  const rows = await reader
    .select({ about: agentQuestions.about })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.issueId, issueId),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
      ),
    )
    .orderBy(agentQuestions.createdAt, agentQuestions.id);
  const seen = new Set<string>();
  const named: QuestionSubject[] = [];
  for (const subject of await subjectsOf(
    rows.map((r) => r.about),
    reader,
  )) {
    if (!subject || seen.has(`${subject.kind}:${subject.key}`)) continue;
    seen.add(`${subject.kind}:${subject.key}`);
    named.push(subject);
  }
  return named;
}
