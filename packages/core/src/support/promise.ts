// A promise a room's session makes a person in their thread (ISS-1012, FB-512): to tell them when an
// issue of a project the room follows reaches an environment, named by the project's own name for
// it. Whether or not the issue was filed from that thread. One the room cannot keep is refused by
// name when it is asked: a project it does not follow, an issue that is no issue or is dropped, a
// key of another prefix or a feedback item's key (ISS-1275), an environment the project does not
// declare or whose serving Forge cannot read. A promise made is
// recorded with who asked, which issue, which environment and when, and noted on the issue for its
// master; the support-results watch answers it once (`promise-watch.ts`).

import type { SupportPromiseRequest } from '@forge/contracts/support';
import { and, eq, inArray } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { supportPromises } from '../db/schema-support.js';
import { feedbackIdOfSeq, triageOutcomesOf } from '../feedback/index.js';
import { heldIssuePrefixes } from '../issues/index.js';
import { parseIssueRef } from '../lib/issue-ref.js';
import { readProjectDocument } from '../project-config/index.js';
import { keyOf } from './ops-reads.js';
import { projectOfKey, type ScopedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { environmentNamed, environmentNames, untrackedWhy } from './promise-rules.js';
import { askerOf } from './propose.js';
import { threadLink } from './record.js';
import { titleWords } from './room-read-words.js';
import { insertAction, type RoomRow } from './store.js';
import { noteInThread } from './thread.js';

export interface PromiseMade {
  promised: true;
  /** False where the same promise already stood in this thread: nothing new was recorded. */
  created: boolean;
  promise: string;
  issue: { key: string; title: string };
  environment: string;
  asker: string;
  next: string;
}

type IssueRow = { id: string; title: string; status: string; issSeq: number };

const ISSUE_COLUMNS = {
  id: issues.id,
  title: issues.title,
  status: issues.status,
  issSeq: issues.issSeq,
};

/**
 * The issue `key` names in the project, read only through a prefix the project numbers its issues
 * with (`held`: any it has held; the legacy `ISS` is always admitted): a key of any other prefix
 * names another record or another project's issue, never this project's issue of the same number
 * (ISS-1275).
 */
async function issueOf(
  projectId: string,
  key: string,
  held: readonly string[],
): Promise<Outcome<IssueRow | null>> {
  const parsed = parseIssueRef(key, held);
  if (!parsed.ok) {
    return no(
      'SUPPORT_PROMISE_KEY_FOREIGN',
      '/issue',
      `${parsed.message} Name the issue by its key in this project. Nothing was promised`,
    );
  }
  const [row] = await db
    .select(ISSUE_COLUMNS)
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq)))
    .limit(1);
  return { ok: true, value: row ?? null };
}

const FEEDBACK_KEY = /^\s*FB-(\d{1,9})\s*$/i;

const feedbackNotIssue = (detail: string): Outcome<never> =>
  no('SUPPORT_PROMISE_FEEDBACK_NOT_ISSUE', '/issue', detail);

/**
 * A feedback item's key is no issue, so no promise is held on it (ISS-1275): the room is told the
 * issue its triage named, to promise on that, or that its triage has named none yet. Refused rather
 * than held on the feedback, because a promise is watched by the issue whose landing reaches an
 * environment, and an untriaged item has no landing to watch.
 */
async function feedbackRefusal(project: ScopedProject, seq: number): Promise<Outcome<never>> {
  const key = `FB-${seq}`;
  const feedbackId = await feedbackIdOfSeq(project.id, seq);
  if (!feedbackId) {
    return feedbackNotIssue(
      `${key} is a feedback item's key, not an issue's, and ${project.slug} holds no ${key}. A promise names an issue; nothing was promised`,
    );
  }
  const carriers = (await triageOutcomesOf([feedbackId])).get(feedbackId)?.issueIds ?? [];
  if (carriers.length === 0) {
    return feedbackNotIssue(
      `${key} is feedback ${project.slug} has not yet triaged into an issue, so no work of it can reach an environment yet. Nothing was promised, and that is no answer for the room: react to their message with support.react, post nothing, and promise once its triage names an issue; if they asked when, answering that question once is allowed`,
    );
  }
  const carrying = await db.select(ISSUE_COLUMNS).from(issues).where(inArray(issues.id, carriers));
  const named = carrying
    .map((i) => `${keyOf(project, i.issSeq)} ("${titleWords(i.title, 'issue')}", ${i.status})`)
    .join(', ');
  return feedbackNotIssue(
    `${key} is feedback, not an issue: its triage carries it on ${named}. Promise on that issue instead; nothing was promised`,
  );
}

/** The project and issue a promise names, or why the room cannot promise about it. */
async function promisedIssue(
  room: RoomRow,
  input: SupportPromiseRequest,
): Promise<Outcome<{ project: ScopedProject; issue: IssueRow; key: string }>> {
  const feedbackSeq = FEEDBACK_KEY.exec(input.issue)?.[1];
  const project = await projectOfKey(room, input.issue, input.project);
  if (!project.ok) {
    if (feedbackSeq) {
      return feedbackNotIssue(
        `${input.issue} is a feedback item's key, not an issue's, and a feedback key names no project. Name its project as well, and you are told the issue it is carried by. Nothing was promised`,
      );
    }
    const [why] = project.refusals;
    return no(
      'SUPPORT_PROMISE_NOT_FOLLOWED',
      why?.path ?? '/issue',
      `${why?.detail ?? `${input.issue} is no issue of a project this room follows`}. A promise is made only about a project this room follows; nothing was promised`,
    );
  }
  const held = await heldIssuePrefixes(project.value.id);
  // a project may number its own issues FB-n; only where it does not is FB-n a feedback key
  if (feedbackSeq && !held.some((p) => p.toUpperCase() === 'FB')) {
    return feedbackRefusal(project.value, Number(feedbackSeq));
  }
  const read = await issueOf(project.value.id, input.issue, held);
  if (!read.ok) return read;
  const issue = read.value;
  const key = issue ? keyOf(project.value, issue.issSeq) : input.issue;
  if (!issue) {
    return no(
      'SUPPORT_PROMISE_ISSUE_UNKNOWN',
      '/issue',
      `${input.issue} names no issue of ${project.value.slug}; read its issues with issues { project: "${project.value.slug}" } and name one. Nothing was promised`,
    );
  }
  if (issue.status === 'dropped') {
    return no(
      'SUPPORT_PROMISE_ISSUE_DROPPED',
      '/issue',
      `${key} ("${titleWords(issue.title, 'issue')}") is dropped: it will not be delivered, so it will reach no environment. Nothing was promised; tell the person so`,
    );
  }
  return { ok: true, value: { project: project.value, issue, key } };
}

/** The environment the promise names, by the project's own name for it, or why it cannot be watched. */
async function promisedEnvironment(
  project: ScopedProject,
  asked: string,
): Promise<Outcome<string>> {
  const held = await readProjectDocument(project.id);
  if (!held) {
    return no(
      'SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED',
      '/environment',
      `${project.slug} declares no project document, so it tracks no environment and none can be watched. Nothing was promised`,
    );
  }
  const env = environmentNamed(held.document.environments, asked);
  if (!env) {
    return no(
      'SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED',
      '/environment',
      `${project.slug} tracks no environment named "${asked}"; the environments it tracks are ${environmentNames(held.document.environments)}. Nothing was promised`,
    );
  }
  const why = untrackedWhy(env.name, env.declaration);
  if (why) {
    return no(
      'SUPPORT_PROMISE_ENVIRONMENT_UNTRACKED',
      '/environment',
      `${why}, so no promise about it can be kept. Nothing was promised`,
    );
  }
  return { ok: true, value: env.name };
}

/** Record a promise to tell the asker when the issue reaches the environment, or refuse it by name. */
export async function makePromise(
  room: RoomRow,
  input: SupportPromiseRequest,
): Promise<Outcome<PromiseMade>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const asked = await askerOf(room, input.thread, input.asker);
  if (!asked.ok) return asked;
  const named = await promisedIssue(room, input);
  if (!named.ok) return named;
  const { project, issue, key } = named.value;
  const environment = await promisedEnvironment(project, input.environment);
  if (!environment.ok) return environment;
  const roomTitle = titleWords(issue.title, 'issue');
  const asker = asked.asker;
  const askerName = asker.label ?? asker.key;
  const [made] = await db
    .insert(supportPromises)
    .values({
      roomId: room.id,
      thread: input.thread,
      projectId: project.id,
      issueId: issue.id,
      environment: environment.value,
      askerKey: asker.key,
      askerLabel: asker.label,
    })
    .onConflictDoNothing()
    .returning({ id: supportPromises.id, createdAt: supportPromises.createdAt });
  const standing =
    made ??
    (
      await db
        .select({ id: supportPromises.id, createdAt: supportPromises.createdAt })
        .from(supportPromises)
        .where(
          and(
            eq(supportPromises.roomId, room.id),
            eq(supportPromises.thread, input.thread),
            eq(supportPromises.issueId, issue.id),
            eq(supportPromises.environment, environment.value),
            eq(supportPromises.state, 'open'),
          ),
        )
        .limit(1)
    )[0];
  if (!standing) throw new Error('support: a promise was neither recorded nor found standing');
  if (made) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId,
      thread: input.thread,
      kind: 'promise_made',
      actorKind: 'session',
      tool: 'promise',
      input: { issue: key, environment: environment.value, asker: asker.key },
      output: { promise: made.id, project: project.slug },
    });
    await noteInThread(
      conversationId,
      `Promised: to tell ${askerName} when ${key} reaches ${environment.value}.`,
    );
    // the project's master reads it on the issue (ISS-1012 criterion 3)
    await postIssueNotice({
      issueId: issue.id,
      authorId: room.principalUserId,
      intent: 'note',
      body: `A support room promised ${askerName} (${await threadLink(room, input.thread)}) to tell them when this issue reaches \`${environment.value}\`. Asked ${made.createdAt.toISOString()}; Forge tells the room once \`${environment.value}\` serves a build holding this issue's landing, or if the issue is dropped first.`,
    });
  }
  return {
    ok: true,
    value: {
      promised: true,
      created: Boolean(made),
      promise: standing.id,
      issue: { key, title: roomTitle },
      environment: environment.value,
      asker: askerName,
      next: `The promise is recorded and the record keeps it; the act is the commitment. Nothing was posted: acknowledge the asker's message with support.react and post nothing about it now. You are told once "${roomTitle}" reaches ${environment.value}, or if it never will; speak once then, in your own words, never a date.`,
    },
  };
}
