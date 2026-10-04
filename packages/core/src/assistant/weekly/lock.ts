import { db } from '../../db/client.js';
import { tryLockXact } from '../../lib/advisory-lock.js';

export type LockOutcome<T> = { acquired: false } | { acquired: true; value: T };

export type WeeklyLock = <T>(
  projectId: string,
  windowId: string,
  fn: () => Promise<T>,
) => Promise<LockOutcome<T>>;

export const withWeeklyLock: WeeklyLock = async (projectId, windowId, fn) =>
  db.transaction(async (tx) => {
    if (!(await tryLockXact(tx, 'assistantWeekly', `${projectId}:${windowId}`))) {
      return { acquired: false };
    }
    return { acquired: true, value: await fn() };
  });
