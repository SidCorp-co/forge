// A support room's promises answered (ISS-1012), by the support-results watch that already hands a
// session what a recorded item came to (`result.ts`): on the same events and the same minute timer,
// each open promise of a project is read again. It is answered once, and never again:
//   - `reached` when its environment first serves a commit holding the issue's landing: the landing
//     as every reader names it (`release-batch:landedBuildsOf`), what the environment serves read
//     as the judged-on environment is (`release-batch:servedOnEnvironment`), and whether that holds
//     the landing as a provider's live contract is weighed (`release-batch:servedCarries`);
//   - `dropped` when the issue is dropped first;
//   - `untracked` when the project stops declaring the environment, or Forge can no longer read it.
// An answer closes the row from `open` in one guarded write, so two watches never tell it twice, and
// the session is handed one note in the thread to say it in its own words.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { supportPromises } from '../db/schema-support.js';
import { issueDisplayIds } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { readProjectDocument } from '../project-config/index.js';
import { landedBuildsOf, servedCarries, servedOnEnvironment } from '../release-batch/index.js';
import type { Reading } from '../release-batch/provider-live.js';
import { deliverWaiting } from './dispatch.js';
import { environmentNamed, promiseNote, untrackedWhy } from './promise-rules.js';
import { insertAction, roomById, threadConversation } from './store.js';

type PromiseRow = typeof supportPromises.$inferSelect;

/** What the watch reads beyond the database: the environment's served commit, and whether it holds a landing. */
export interface PromiseWatchDeps {
  served(projectId: string, environment: string): Promise<Reading<string>>;
  carries(projectId: string, landing: string, served: string): Promise<Reading<boolean>>;
}

const LIVE: PromiseWatchDeps = {
  served: (projectId, environment) => servedOnEnvironment(projectId, environment),
  carries: servedCarries,
};

/** Every project holding an open promise. */
export async function projectsWithOpenPromises(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: supportPromises.projectId })
    .from(supportPromises)
    .where(eq(supportPromises.state, 'open'));
  return rows.map((r) => r.projectId);
}

/** Read each open promise about one project's issues again; answer each that is due. */
export async function tellProjectPromises(
  projectId: string,
  deps: PromiseWatchDeps = LIVE,
): Promise<number> {
  const open = await db
    .select()
    .from(supportPromises)
    .where(and(eq(supportPromises.projectId, projectId), eq(supportPromises.state, 'open')));
  if (open.length === 0) return 0;
  const issueIds = [...new Set(open.map((p) => p.issueId))];
  const [rows, shown, landed, held] = await Promise.all([
    db
      .select({ id: issues.id, title: issues.title, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, issueIds)),
    issueDisplayIds(issueIds),
    landedBuildsOf(issueIds),
    readProjectDocument(projectId),
  ]);
  const issueOf = new Map(rows.map((r) => [r.id, r]));
  // one reading of each environment per pass, whichever promises name it
  const servedNow = new Map<string, Promise<Reading<string>>>();
  let told = 0;
  for (const promise of open) {
    const issue = issueOf.get(promise.issueId);
    const facts = {
      title: issue?.title ?? 'the work',
      key: shown.get(promise.issueId) ?? promise.issueId,
      environment: promise.environment,
      asker: promise.askerLabel ?? promise.askerKey,
    };
    if (!issue || issue.status === 'dropped') {
      if (await answer(promise, 'dropped', promiseNote('dropped', facts))) told++;
      continue;
    }
    const env = held ? environmentNamed(held.document.environments, promise.environment) : null;
    if (!env || untrackedWhy(env.name, env.declaration)) {
      if (await answer(promise, 'untracked', promiseNote('untracked', facts))) told++;
      continue;
    }
    const landing = landed.get(promise.issueId.toLowerCase())?.sha ?? null;
    if (!landing) continue;
    let reading = servedNow.get(env.name);
    if (!reading) {
      reading = deps.served(projectId, env.name);
      servedNow.set(env.name, reading);
    }
    const served = await reading;
    if (!served.ok) continue;
    const carried = await deps.carries(projectId, landing, served.value);
    if (!carried.ok) {
      logger.debug(
        { promiseId: promise.id, why: carried.why },
        'support: whether an environment holds a promised landing is unread; read again next pass',
      );
      continue;
    }
    if (!carried.value) continue;
    if (await answer(promise, 'reached', promiseNote('reached', facts), served.value)) told++;
  }
  return told;
}

/**
 * Close a promise from `open` and hand its room's session the note, once: the guarded write is the
 * only claim, so a second watch reading the same promise finds it answered and tells nothing.
 */
async function answer(
  promise: PromiseRow,
  state: 'reached' | 'dropped' | 'untracked',
  note: string,
  servedCommit: string | null = null,
): Promise<boolean> {
  const [closed] = await db
    .update(supportPromises)
    .set({ state, answeredAt: sql`now()`, servedCommit })
    .where(and(eq(supportPromises.id, promise.id), eq(supportPromises.state, 'open')))
    .returning({ id: supportPromises.id });
  if (!closed) return false;
  const room = await roomById(promise.roomId);
  if (!room) return false;
  const conversationId = await threadConversation(room.id, promise.thread);
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: promise.thread,
    kind: 'message_in',
    actorKind: 'core',
    input: { note },
    externalId: `promise:${promise.id}`,
  });
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: promise.thread,
    kind: 'promise_told',
    actorKind: 'core',
    tool: 'promise',
    input: { promise: promise.id, environment: promise.environment },
    output: { state, ...(servedCommit ? { servedCommit } : {}) },
  });
  await deliverWaiting(room.id).catch((err) =>
    logger.error({ err, roomId: room.id }, 'support: a promise note waits for the next turn'),
  );
  return true;
}

/** Every open promise read again (the support-results timer): a deploy to staging emits no event. */
export async function tellAllPromises(deps: PromiseWatchDeps = LIVE): Promise<void> {
  for (const projectId of await projectsWithOpenPromises()) {
    await tellProjectPromises(projectId, deps).catch((err) =>
      logger.error({ err, projectId }, 'support: answering promises failed'),
    );
  }
}
