/** One cancellation state per backlog stream (ISS-1173), tripped by a disconnect, the budget or
 *  shutdown, and checked before a producer starts anything — a page read, an embedding batch, each
 *  per-seed search — so a client that goes mid-page does not buy the rest of it. Work already in
 *  flight finishes and is discarded, and the first cause wins. */

export type CancelCause = 'disconnect' | 'budget' | 'shutdown';

export class Cancellation {
  private cause: CancelCause | null = null;
  private readonly listeners = new Set<(cause: CancelCause) => void>();

  cancel(cause: CancelCause): void {
    if (this.cause !== null) return;
    this.cause = cause;
    for (const listener of this.listeners) listener(cause);
    this.listeners.clear();
  }

  get cancelled(): boolean {
    return this.cause !== null;
  }

  get reason(): CancelCause | null {
    return this.cause;
  }

  onCancel(listener: (cause: CancelCause) => void): void {
    if (this.cause !== null) {
      listener(this.cause);
      return;
    }
    this.listeners.add(listener);
  }
}

export function startBudget(cancellation: Cancellation, budgetMs: number): () => void {
  const timer = setTimeout(() => cancellation.cancel('budget'), budgetMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
