import { AsyncLocalStorage } from 'node:async_hooks';

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
 * Answers `keyOf(id)` for every project in `projectIds` from one statement, `readAll`, inside a
 * {@link withReadMemo} scope: a read across projects primes what each project's own read would
 * otherwise send once a project (`development/needs-you-viewer.ts:readNeedsYouAcross`). A key already
 * held keeps its answer; outside a scope nothing is read, and each project's read reads on its own.
 * A failed statement is not kept, so each project's read then tries on its own and fails there.
 */
export function primeReads<R>(
  projectIds: readonly string[],
  keyOf: (projectId: string) => string,
  readAll: (projectIds: readonly string[]) => Promise<R[]>,
  projectOf: (row: R) => string,
): void {
  const memo = memos.getStore();
  if (!memo) return;
  const ids = projectIds.filter((id) => !memo.has(keyOf(id)));
  if (ids.length === 0) return;
  // a query builder is a thenable that sends its statement again on every `then`: send it once
  const all = Promise.resolve(readAll(ids));
  for (const id of ids) {
    const key = keyOf(id);
    const held = all.then((rows) => rows.filter((r) => projectOf(r) === id));
    memo.set(key, held);
    held.catch(() => memo.delete(key));
  }
}

/**
 * `read(ids)` keyed per id inside a {@link withReadMemo} scope: an id an earlier ask under `key`
 * already read is answered from that read, and only the rest are read, in one statement. A read
 * whose answer for an id does not depend on which other ids it was asked with (a row per issue,
 * filtered by the issue's own id) may take it, so two reads over overlapping sets of issues in one
 * request (Needs you's open issues and the issues its requirements trace) send each fact once. The
 * answer holds the ids in the order asked; outside a scope, `read` answers every id itself.
 */
export async function memoizedPerId<V>(
  key: string,
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V>> {
  const memo = memos.getStore();
  if (!memo) return new Map(await read(ids));
  const unique = [...new Set(ids)];
  const slot = (id: string) => `${key}\u0000${id}`;
  const missing = unique.filter((id) => !memo.has(slot(id)));
  if (missing.length > 0) {
    const all = Promise.resolve(read(missing));
    for (const id of missing) {
      const held = all.then((m) => (m.has(id) ? { value: m.get(id) as V } : null));
      memo.set(slot(id), held);
      held.catch(() => memo.delete(slot(id)));
    }
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
