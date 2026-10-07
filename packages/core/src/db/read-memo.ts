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
    held = read();
    memo.set(key, held);
    held.catch(() => memo.delete(key));
  }
  return held.then((value) => structuredClone(value));
}
