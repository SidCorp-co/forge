import type { ContractWaitTargetRefusal } from '@forge/contracts/contract-waits';

// An instant with its zone: a date alone or a local time would be a guess at which midnight is meant
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A hand-added wait's deadline: absent is none; malformed or not in the future is refused by name. */
export function dueAtOf(
  raw: string | undefined,
  now: Date,
): { ok: true; value: Date | null } | { ok: false; refusal: ContractWaitTargetRefusal } {
  if (raw === undefined) return { ok: true, value: null };
  const at = INSTANT.test(raw) ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return {
      ok: false,
      refusal: {
        code: 'CONTRACT_WAIT_DUE_MALFORMED',
        path: '/dueAt',
        detail: `"${raw}" is not an instant; dueAt is an ISO 8601 date-time with its zone, such as 2026-11-01T00:00:00Z.`,
      },
    };
  }
  if (at.getTime() <= now.getTime()) {
    return {
      ok: false,
      refusal: {
        code: 'CONTRACT_WAIT_DUE_PAST',
        path: '/dueAt',
        detail: `dueAt ${at.toISOString()} is not after now (${now.toISOString()}); a deadline a wait is added with lies ahead of it.`,
      },
    };
  }
  return { ok: true, value: at };
}
