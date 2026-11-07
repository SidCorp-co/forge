import { AsyncLocalStorage } from 'node:async_hooks';
import { whenQuiet } from './query-timing.js';

/**
 * One read request's answers to the lookups its handlers repeat: who the caller is in a project,
 * the project's configuration document, its issue prefix. A page's reads ask these again for every
 * list they assemble (a project's needs-you asks its access twelve times), and each ask was a round
 * trip that held a pool connection. Inside a read the answer cannot change, so the first ask is
 * reused; a write request takes no memo, so a handler that changes one of these reads its own write.
 */
const memos = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Runs `fn` with a fresh memo every {@link memoizedRead} inside it shares. */
export function withReadMemo<T>(fn: () => T): T {
  return memos.run(new Map(), fn);
}

/**
 * `read()` once per `key` inside a {@link withReadMemo} scope, and every time outside one. Each caller
 * gets its own copy, so one caller changing what it was handed cannot change another's answer. A
 * read that fails is not kept, so the next ask tries again and fails on its own.
 */
export function memoizedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const memo = memos.getStore();
  if (!memo) return read();
  let held = memo.get(key) as Promise<T> | undefined;
  if (!held) {
    // a query builder sends its statement again on every `then`: send it once
    held = Promise.resolve(read());
    memo.set(key, held);
    held.catch(() => memo.delete(key));
  }
  return held.then((value) => structuredClone(value));
}

/**
 * One project's answer to a read that `readAll` makes for any set of projects: every project asked
 * under `key` before the request's quiet point is read in one statement ({@link rowsPerProject}), and
 * `answer` is handed this project's rows in the order `readAll` sent them, so a project read alone and
 * read beside others answers alike. Outside a scope, every ask reads its own project.
 */
export async function perProjectRead<R, V>(
  key: string,
  projectId: string,
  readAll: (projectIds: readonly string[]) => Promise<R[]>,
  projectOf: (row: R) => string,
  answer: (rows: R[]) => V,
): Promise<V> {
  return answer(await rowsPerProject(key, projectId, readAll, projectOf));
}

/** The ids asked under one key before the request's next quiet point, read together there. */
interface PendingBatch {
  ids: Set<string>;
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, unknown>>;
  done: Promise<ReadonlyMap<string, unknown>>;
}

/** The projects a read across projects declared in each memo ({@link readingAcross}). */
const across = new WeakMap<Map<string, Promise<unknown>>, ReadonlySet<string>>();

/**
 * Declares, inside a {@link withReadMemo} scope, the projects a read across a person's projects
 * reads side by side (`development/needs-you-viewer.ts:readNeedsYouAcross`, the home): a read keyed
 * by project ({@link memoizedPerProject}, {@link rowsPerProject}) then reads every one of them in its
 * one statement, so a project whose read reaches it later than the others finds its answer held. It
 * admits nothing: a project's answer is only ever handed to that project's own read, which its caller
 * has already checked. Outside a scope it does nothing.
 */
export function readingAcross(projectIds: readonly string[]): void {
  const memo = memos.getStore();
  if (!memo) return;
  across.set(memo, new Set([...(across.get(memo) ?? []), ...projectIds]));
}

const slotOf = (key: string, id: string) => `${key}\u0000${id}`;

/** Holds `id`'s answer under `key` as what `done` answers for it, dropped where the read fails. */
function hold(
  memo: Map<string, Promise<unknown>>,
  key: string,
  id: string,
  done: Promise<ReadonlyMap<string, unknown>>,
): void {
  const held = done.then((m) => (m.has(id) ? { value: m.get(id) } : null));
  memo.set(slotOf(key, id), held);
  held.catch(() => memo.delete(slotOf(key, id)));
}

const batches = new WeakMap<Map<string, Promise<unknown>>, Map<string, PendingBatch>>();

/**
 * The batch of `key` gathering now, opened on its first ask and read at the request's next quiet
 * point (`db/query-timing.ts:whenQuiet`): every concurrent read has then asked what it can ask before
 * an answer it waits on, so each project's read of a person's projects asks into one statement
 * however many statements it sent before. The first asker's `read` reads for all of them: a key
 * names one read.
 */
function batchOf(
  memo: Map<string, Promise<unknown>>,
  key: string,
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, unknown>>,
  byProject: boolean,
): PendingBatch {
  let open = batches.get(memo);
  if (!open) {
    open = new Map();
    batches.set(memo, open);
  }
  const held = open.get(key);
  if (held) return held;
  const pending = { ids: new Set<string>(), read } as PendingBatch;
  pending.done = new Promise((resolve, reject) => {
    whenQuiet(() => {
      open.delete(key);
      // a read by project reads every project the read across declared and nothing holds yet
      if (byProject) {
        for (const id of across.get(memo) ?? []) {
          if (pending.ids.has(id) || memo.has(slotOf(key, id))) continue;
          pending.ids.add(id);
          hold(memo, key, id, pending.done);
        }
      }
      Promise.resolve(pending.read([...pending.ids])).then(resolve, reject);
    });
  });
  open.set(key, pending);
  return pending;
}

/**
 * `read(ids)` keyed per id inside a {@link withReadMemo} scope: an id an earlier ask under `key`
 * already read is answered from that read, and the rest of every ask made before the request's next
 * quiet point are read together, in one statement. A read whose answer for an id does not depend on
 * which other ids it was asked with (a row per issue, filtered by the issue's own id) may take it, so
 * two reads over overlapping sets of issues in one request (Needs you's open issues and the issues
 * its requirements trace), and each project's read of a person's projects read side by side, send
 * each fact once (ISS-1070 r6). The answer holds the ids in the order asked; outside a scope, `read`
 * answers every id itself.
 */
export function memoizedPerId<V>(
  key: string,
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V>> {
  return perId(key, ids, read, false);
}

/**
 * {@link memoizedPerId} over project ids: a read keyed by project, which reads with them every
 * project the read across projects declared ({@link readingAcross}).
 */
export function memoizedPerProject<V>(
  key: string,
  projectIds: readonly string[],
  read: (projectIds: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V>> {
  return perId(key, projectIds, read, true);
}

async function perId<V>(
  key: string,
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
  byProject: boolean,
): Promise<Map<string, V>> {
  const memo = memos.getStore();
  if (!memo) return new Map(await read(ids));
  const unique = [...new Set(ids)];
  const slot = (id: string) => slotOf(key, id);
  const missing = unique.filter((id) => !memo.has(slot(id)));
  if (missing.length > 0) {
    const batch = batchOf(memo, key, read, byProject);
    for (const id of missing) {
      batch.ids.add(id);
      hold(memo, key, id, batch.done);
    }
  } else {
    // an ask answered from what is held still waits for the quiet point, as one that reads does: the
    // reads of a person's projects then ask each fact in the same wave, whichever asked it first
    await new Promise<void>((answered) => whenQuiet(answered));
  }
  const out = new Map<string, V>();
  const answers = await Promise.all(
    unique.map((id) => memo.get(slot(id)) as Promise<{ value: V } | null>),
  );
  unique.forEach((id, i) => {
    const held = answers[i];
    if (held) out.set(id, structuredClone(held.value));
  });
  return out;
}

const producing = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Offers what `produce` answers under `key` to later asks in this read ({@link heldRead}), where a
 * read assembles a model a second read would otherwise build again from its own statements. Inside
 * `produce` the key is not held, so a read it reaches never waits on its own answer.
 */
export function offerRead<T>(key: string, produce: () => Promise<T>): Promise<T> {
  const memo = memos.getStore();
  const inside = new Set([...(producing.getStore() ?? []), key]);
  const made = producing.run(inside, produce);
  if (memo && !memo.has(key)) {
    memo.set(key, made);
    made.catch(() => memo.delete(key));
  }
  return made;
}

/** What an earlier {@link offerRead} in this read holds under `key`, or undefined where none does. */
export function heldRead<T>(key: string): Promise<T> | undefined {
  if (producing.getStore()?.has(key)) return undefined;
  return memos.getStore()?.get(key) as Promise<T> | undefined;
}

/** How many reads {@link rowsPerId} has sent, so rows of an earlier one sort before a later's. */
let statementsSent = 0;

/**
 * The rows `fetch` answers for `ids`, where each row belongs to the one id `idOf` names and a row's
 * presence does not depend on which other ids were asked: asked by several reads before a quiet
 * point (each project's read of a person's projects), one statement answers all of them
 * (`memoizedPerId`). Each id's rows come back in the order `fetch` sent them; an id read in an
 * earlier statement comes before one read in a later.
 */
export function rowsPerId<R>(
  key: string,
  ids: readonly string[],
  fetch: (ids: readonly string[]) => PromiseLike<R[]>,
  idOf: (row: R) => string,
): Promise<R[]> {
  return rowsOf(key, ids, fetch, idOf, false);
}

async function rowsOf<R>(
  key: string,
  ids: readonly string[],
  fetch: (ids: readonly string[]) => PromiseLike<R[]>,
  idOf: (row: R) => string,
  byProject: boolean,
): Promise<R[]> {
  const byId = await perId(
    key,
    ids,
    async (some) => {
      const out = new Map<string, { sent: number; at: number; row: R }[]>(
        some.map((id) => [id, []]),
      );
      const sent = ++statementsSent;
      const rows = await fetch(some);
      for (const [at, row] of rows.entries()) out.get(idOf(row))?.push({ sent, at, row });
      return out;
    },
    byProject,
  );
  return [...byId.values()]
    .flat()
    .sort((a, b) => a.sent - b.sent || a.at - b.at)
    .map((r) => r.row);
}

/**
 * The rows `fetch` answers for `projectId`, every project asked before the request's quiet point,
 * and every project a read across declared ({@link readingAcross}), read in one statement, in the
 * order `fetch` sent them.
 */
export function rowsPerProject<R>(
  key: string,
  projectId: string,
  fetch: (projectIds: readonly string[]) => PromiseLike<R[]>,
  projectOf: (row: R) => string,
): Promise<R[]> {
  return rowsOf(key, [projectId], fetch, projectOf, true);
}

/**
 * What `read` answers for `id`, every id asked under `key` before the request's quiet point read in
 * one statement ({@link memoizedPerId}); undefined where `read` holds no answer for it.
 */
export async function onePerId<V>(
  key: string,
  id: string,
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<V | undefined> {
  return (await memoizedPerId(key, [id], read)).get(id);
}

/** {@link onePerId} keyed by project: it reads with it every project a read across declared. */
export async function onePerProject<V>(
  key: string,
  projectId: string,
  read: (projectIds: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<V | undefined> {
  return (await memoizedPerProject(key, [projectId], read)).get(projectId);
}

/** One id for {@link onePerId} made of several parts, a project and a version say ({@link partsOf}). */
export const idOfParts = (...parts: readonly string[]): string => parts.join('\u0001');

/** The parts {@link idOfParts} joined. */
export const partsOf = (id: string): string[] => id.split('\u0001');
