import type { BenchClient } from '../client.js';
import type { ChatLogRow } from '../trail.js';

/** A `chat_logs` row with the fields history reads beyond what the benchmark's trail needs. */
export type HistoryRow = ChatLogRow & {
  query: string | null;
  model: string | null;
  source: string | null;
  /** `chat_logs.user_key`; absent from rows the route served before it carried the column. */
  userKey?: string | null;
};

export interface Window {
  projectSlug: string;
  /** ISO dates; `from` must be before `to`. */
  from: string;
  to: string;
  source?: string;
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}

/** Refuse a window that is not a window. */
export function assertWindow(w: Window): void {
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  if (Number.isNaN(from)) throw new WindowError(`--from ${w.from} is not a date`);
  if (Number.isNaN(to)) throw new WindowError(`--to ${w.to} is not a date`);
  if (from >= to) throw new WindowError(`--from ${w.from} is not before --to ${w.to}`);
}

/** Every row of the window, oldest first. */
export async function readWindow(client: BenchClient, w: Window): Promise<HistoryRow[]> {
  assertWindow(w);
  const query = {
    projectSlug: w.projectSlug,
    dateFrom: w.from,
    dateTo: w.to,
    ...(w.source ? { source: w.source } : {}),
  };
  const rows = await client.trail<HistoryRow>(query);
  return [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
