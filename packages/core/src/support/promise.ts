// A promise a room's session makes a person in their thread (ISS-1012, FB-512): to tell them when an
// issue of a project the room follows reaches an environment, named by the project's own name for
// it. Whether or not the issue was filed from that thread. One the room cannot keep is refused by
// name when it is asked: a project it does not follow, an issue that is no issue or is dropped, an
// environment the project does not declare or whose serving Forge cannot read. A promise made is
// recorded with who asked, which issue, which environment and when, and noted on the issue for its
// master; the support-results watch answers it once (`promise-watch.ts`).

import type { SupportPromiseRequest } from '@forge/contracts/support';
import { and, eq } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { supportPromises } from '../db/schema-support.js';
import { readProjectDocument } from '../project-config/index.js';
import { keyOf } from './ops-reads.js';
import { projectOfKey, type ScopedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { environmentNamed, environmentNames, untrackedWhy } from './promise-rules.js';
import { askerOf } from './propose.js';
import { threadLink } from './record.js';
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

async function issueOf(projectId: string, key: string): Promise<IssueRow | null> {
  const seq = Number(key.replace(/^\D+/, ''));
  if (!Number.isSafeInteger(seq)) return null;
  const [row] = await db
    .select({ id: issues.id, title: issues.title, status: issues.status, issSeq: issues.issSeq })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.issSeq, seq)))
    .limit(1);
  return row ?? null;
}

/** The project and issue a promise names, or why the room cannot promise about it. */
async function promisedIssue(
  room: RoomRow,
  input: SupportPromiseRequest,
): Promise<Outcome<{ project: ScopedProject; issue: IssueRow; key: string }>> {
  const project = await projectOfKey(room, input.issue, input.project);
  if (!project.ok) {
    const [why] = project.refusals;
    return no(
      'SUPPORT_PROMISE_NOT_FOLLOWED',
      why?.path ?? '/issue',
      `${why?.detail ?? `${input.issue} is no issue of a project this room follows`}. A promise is made only about a project this room follows; nothing was promised`,
    );
  }
  const issue = await issueOf(project.value.id, input.issue);
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
      `${key} ("${issue.title}") is dropped: the team will not deliver it, so it will reach no environment. Nothing was promised; tell the person so`,
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
      issue: { key, title: issue.title },
      environment: environment.value,
      asker: askerName,
      next: `Nothing was posted. Tell ${askerName} in your own words that you will let them know here when "${issue.title}" reaches ${environment.value}; never promise a date. You are told once it does, or if it never will; post nothing about it before then.`,
    },
  };
}
