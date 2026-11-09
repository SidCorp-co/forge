// What a question is about, as a person reads it (`subject`): the stored `about` resolved to the key
// and title every reader names it by, so the person answering never has to ask which requirement a
// business question concerns (ISS-583). One statement per kind for a page of rows.

import type { QuestionAbout, QuestionSubject } from '@forge/contracts/questions';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { memoizedPerId } from '../db/read-memo.js';
import { feedback } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { requirements } from '../db/schema-requirements.js';

type Reader = Pick<Tx, 'select'>;

type Named = { key: string; title: string };

/** Each requirement's or feedback item's key and title, by id, as `reader` reads them. */
async function namedRead(
  kind: 'requirement' | 'feedback',
  ids: readonly string[],
  reader: Reader,
): Promise<Map<string, Named>> {
  if (kind === 'requirement') {
    const found = await reader
      .select({ id: requirements.id, seq: requirements.reqSeq, title: requirements.title })
      .from(requirements)
      .where(inArray(requirements.id, [...ids]));
    return new Map(found.map((r) => [r.id, { key: `REQ-${r.seq}`, title: r.title }]));
  }
  const found = await reader
    .select({ id: feedback.id, seq: feedback.fbSeq, title: feedback.title })
    .from(feedback)
    .where(inArray(feedback.id, [...ids]));
  return new Map(found.map((f) => [f.id, { key: `FB-${f.seq}`, title: f.title }]));
}

/**
 * {@link namedRead}, read outside a transaction once a request for every project's questions asked
 * before the quiet point (`db/read-memo.ts:memoizedPerId`): a person's attention read the questions
 * of each project, and again for its decisions, one statement each time a project's questions named
 * a requirement (ISS-1070 r20). A transaction reads its own.
 */
function namedOf(
  kind: 'requirement' | 'feedback',
  ids: readonly string[],
  reader: Reader,
): Promise<Map<string, Named>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  if (reader !== db) return namedRead(kind, ids, reader);
  return memoizedPerId(`questionSubject:${kind}`, ids, (some) => namedRead(kind, some, db));
}

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
  const [reqs, items] = await Promise.all([
    namedOf('requirement', requirementIds, reader),
    namedOf('feedback', feedbackIds, reader),
  ]);
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
