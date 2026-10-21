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
