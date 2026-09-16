import type { Task } from '../task.js';
import type { HistoryRow } from './row.js';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One anchored pattern per shipped turn message, each `{placeholder}` read as a wildcard. */
export function benchMessagePatterns(tasks: readonly Task[]): RegExp[] {
  return tasks.flatMap((t) =>
    t.turns.map(
      (turn) =>
        new RegExp(
          `^${turn.message
            .split(/\{[a-zA-Z0-9]+\}/)
            .map(escapeRe)
            .join('[\\s\\S]+?')}$`,
        ),
    ),
  );
}

/**
 * The sessions that MAY be a shipped task's: every row's query is a task's turn message. Bench rooms
 * are deleted with a read-back after every trial, so their titles cannot be read from a window
 * afterwards; the messages are the one mark the rows keep (ISS-1065 D2). A session with one such row
 * beside any other query is a person's and stays; the caller then keeps only the candidates whose
 * room is gone, since a person's room is still there (codex F1).
 */
export function benchSessions(rows: HistoryRow[], tasks: readonly Task[]): string[] {
  const patterns = benchMessagePatterns(tasks);
  const verdict = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const isTask = row.query !== null && patterns.some((p) => p.test(row.query as string));
    verdict.set(row.sessionId, (verdict.get(row.sessionId) ?? true) && isTask);
  }
  return [...verdict.entries()]
    .filter(([, all]) => all)
    .map(([id]) => id)
    .sort();
}
