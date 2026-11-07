import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { frozen } from './frozen.js';
import { currentQueryTiming, newQueryTiming, whenQuiet, withQueryTiming } from './query-timing.js';

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
 * `read()` once per `key` inside a {@link withReadMemo} scope, and every time outside one. Every caller
 * is handed the one answer, made read-only (`db/frozen.ts`): a caller that writes into it throws
 * there, so it can never change another caller's answer, and nothing is copied per ask (ISS-1070
 * r6). A read that fails is not kept, so the next ask tries again and fails on its own.
 */
export function memoizedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const memo = memos.getStore();
  if (!memo) return read();
  let held = memo.get(key) as Promise<T> | undefined;
  if (!held) {
    // a query builder sends its statement again on every `then`: send it once
    held = Promise.resolve(read()).then(frozen);
    memo.set(key, held);
    held.catch(() => memo.delete(key));
  }
  return held;
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
  /** What `done` answers, each value made read-only once: what every id of the batch is held as. */
  answered: Promise<ReadonlyMap<string, unknown>>;
}

/** The projects a read across projects declared in each memo ({@link readAcross}). */
const across = new WeakMap<Map<string, Promise<unknown>>, ReadonlySet<string>>();

/** One project's read inside a {@link readAcross}: the keys it has asked so far. */
interface Flow {
  asked: Set<string>;
}

/** The projects' reads of each memo's {@link readAcross} still running. */
const flowsOf = new WeakMap<Map<string, Promise<unknown>>, Set<Flow>>();
const inFlow = new AsyncLocalStorage<Flow>();

/**
 * `read` for each of a person's projects, side by side, inside a {@link withReadMemo} scope
 * (`development/needs-you-viewer.ts:readNeedsYouAcross`, the home). A read keyed by project
 * ({@link memoizedPerProject}, {@link rowsPerProject}) reads every one of them in its one statement,
 * so a project whose read reaches it later than the others finds its answer held. A read keyed by
 * id waits, while another project's read can still go on, for every running project's read to ask
 * it, so a project that reaches it a step later than another asks in the same statement: the count
 * of statements does not grow with the projects (ISS-1070 r6). It admits nothing: a project's answer
 * is only ever handed to that project's own read, which its caller has already checked. Outside a
 * scope it opens one of its own for the call.
 */
export function readAcross<P, T>(
  projects: readonly P[],
  idOf: (project: P) => string,
  read: (project: P) => Promise<T>,
): Promise<T[]> {
  const memo = memos.getStore();
  // outside a request the read opens a scope of its own, so its projects still batch rather than
  // each send its own hundred statements at once to the pool
  if (!memo) {
    const own = () => withReadMemo(() => readAcross(projects, idOf, read));
    return currentQueryTiming() ? own() : withQueryTiming(newQueryTiming(), own);
  }
  across.set(memo, new Set([...(across.get(memo) ?? []), ...projects.map(idOf)]));
  let running = flowsOf.get(memo);
  if (!running) {
    running = new Set();
    flowsOf.set(memo, running);
  }
  const live = running;
  return Promise.all(
    projects.map((p) => {
      const flow: Flow = { asked: new Set() };
      live.add(flow);
      return inFlow.run(flow, () => read(p)).finally(() => live.delete(flow));
    }),
  );
}

/** How many projects' reads of each memo have asked each key. */
const askersOf = new WeakMap<Map<string, Promise<unknown>>, Map<string, number>>();

/** Records that the project's read running this code asked `key`, where one does. */
function asked(memo: Map<string, Promise<unknown>>, key: string): void {
  const flow = inFlow.getStore();
  if (!flow || flow.asked.has(key)) return;
  flow.asked.add(key);
  let askers = askersOf.get(memo);
  if (!askers) {
    askers = new Map();
    askersOf.set(memo, askers);
  }
  askers.set(key, (askers.get(key) ?? 0) + 1);
}

/**
 * How long a read by id asked by a project's read waits (`db/query-timing.ts:whenQuiet`): not at all
 * once every project's read still running has asked it, else as many as have asked it. Where every
 * read waits on a key another has yet to ask, the keys fewest of them asked are read first: a
 * project's read a step behind the others goes on to the key they wait on.
 */
const heldFor = (memo: Map<string, Promise<unknown>>, key: string) => () =>
  [...(flowsOf.get(memo) ?? [])].some((f) => !f.asked.has(key))
    ? (askersOf.get(memo)?.get(key) ?? 0) + 1
    : 0;

const slotOf = (key: string, id: string) => `${key}\u0000${id}`;

/**
 * Holds `id` under `key` as its batch's answer: one promise and one freeze a batch, not one an id, so
 * a person's twelve projects asking four thousand issues wait on a handful of promises (ISS-1070 r6).
 */
function hold(
  memo: Map<string, Promise<unknown>>,
  key: string,
  id: string,
  batch: PendingBatch,
): void {
  memo.set(slotOf(key, id), batch.answered);
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
    // a read by project reads every declared project at once; a read by id a project's read asked
    // waits for the reads that have yet to ask it ({@link readAcross})
    const held = byProject || !inFlow.getStore() ? undefined : heldFor(memo, key);
    whenQuiet(() => {
      open.delete(key);
      // a read by project reads every project the read across declared and nothing holds yet
      if (byProject) {
        for (const id of across.get(memo) ?? []) {
          if (pending.ids.has(id) || memo.has(slotOf(key, id))) continue;
          pending.ids.add(id);
          hold(memo, key, id, pending);
        }
      }
      // what the read asks in turn is the batch's, not the project's read that opened it
      if (pending.ids.size === 0) resolve(new Map());
      else inFlow.exit(() => Promise.resolve(pending.read([...pending.ids]))).then(resolve, reject);
    }, held);
  });
  pending.answered = pending.done.then((m) => {
    for (const v of m.values()) frozen(v);
    return m;
  });
  // a read that fails is not kept: each id it held is asked again by the next read
  pending.answered.catch(() => {
    for (const id of pending.ids)
      if (memo.get(slotOf(key, id)) === pending.answered) memo.delete(slotOf(key, id));
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
 * {@link memoizedPerId} for a read made inside one project (`read(projectId, ids)`): each id is held
 * as the project's, and the asks of every project's read are answered by one batch, which reads each
 * project's ids with that project's read. One key serves every project, so a read across projects
 * waits on it as on any key they share ({@link readAcross}).
 */
export async function memoizedInProject<V>(
  key: string,
  projectId: string,
  ids: readonly string[],
  read: (projectId: string, ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V>> {
  const held = await memoizedPerId(
    key,
    ids.map((id) => idOfParts(projectId, id)),
    async (some) => {
      const byProject = new Map<string, string[]>();
      for (const part of some) {
        const [project, id] = partsOf(part) as [string, string];
        byProject.set(project, [...(byProject.get(project) ?? []), id]);
      }
      const out = new Map<string, V>();
      await Promise.all(
        [...byProject].map(async ([project, own]) => {
          for (const [id, v] of await read(project, own)) out.set(idOfParts(project, id), v);
        }),
      );
      return out;
    },
  );
  return new Map([...held].map(([part, v]) => [partsOf(part)[1] as string, v]));
}

/**
 * {@link memoizedPerId} over project ids: a read keyed by project, which reads with them every
 * project the read across projects declared ({@link readAcross}).
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
  // no id asks nothing: a read is never sent for an empty list (`IN ()` is no statement)
  if (!memo) return ids.length === 0 ? new Map() : new Map(await read(ids));
  const unique = [...new Set(ids)];
  // a request reading one project at most has no other project's read to wait for
  if ((across.get(memo)?.size ?? 0) <= 1) return perSet(memo, key, unique, read);
  asked(memo, key);
  const slot = (id: string) => slotOf(key, id);
  const missing = unique.filter((id) => !memo.has(slot(id)));
  if (missing.length > 0) {
    const batch = batchOf(memo, key, read, byProject);
    for (const id of missing) {
      batch.ids.add(id);
      hold(memo, key, id, batch);
    }
  } else {
    // an ask answered from what is held still waits for the quiet point, as one that reads does: the
    // reads of a person's projects then ask each fact in the same wave, whichever asked it first
    await new Promise<void>((answered) => whenQuiet(answered));
  }
  // each id waits on its batch's answer: a handful of batches however many ids
  const held = unique.map((id) => memo.get(slot(id)) as Promise<ReadonlyMap<string, V>>);
  const batchesOf = [...new Set(held)];
  const answers = new Map(
    (await Promise.all(batchesOf)).map((m, i) => [batchesOf[i] as Promise<unknown>, m]),
  );
  const out = new Map<string, V>();
  unique.forEach((id, i) => {
    const m = answers.get(held[i] as Promise<unknown>);
    if (m?.has(id)) out.set(id, m.get(id) as V);
  });
  return out;
}

/**
 * A request that reads one project at most (a project's own page, or a person in one project) reads
 * each ask as it comes, once for each distinct set of ids under `key`, beside the request's other
 * statements: held for a quiet point, every batch waits on the slowest statement in flight and the
 * work of its answer stops overlapping the rest, for a handful of statements saved (ISS-1070 r6).
 * It is keyed by the whole set, as r5's per-set read was: an ask whose ids another ask read in part
 * reads them again, so how many statements a read sends never hangs on which ask came first.
 */
function perSet<V>(
  memo: Map<string, Promise<unknown>>,
  key: string,
  unique: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V>> {
  if (unique.length === 0) return Promise.resolve(new Map());
  const set = [...unique].sort();
  const slot = `${key}\u0002${createHash('sha1').update(set.join(',')).digest('hex')}`;
  let held = memo.get(slot) as Promise<ReadonlyMap<string, V>> | undefined;
  if (!held) {
    held = Promise.resolve(read(set)).then((m) => {
      for (const v of m.values()) frozen(v);
      return m;
    });
    memo.set(slot, held);
    held.catch(() => memo.delete(slot));
  }
  return held.then((m) => {
    const out = new Map<string, V>();
    for (const id of unique) if (m.has(id)) out.set(id, m.get(id) as V);
    return out;
  });
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
 * and every project a read across declared ({@link readAcross}), read in one statement, in the
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
