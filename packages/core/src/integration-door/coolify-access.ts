/** What the Coolify routes share: how Coolify's own refusal is named, and the options a caller set. */

import { CoolifyApiError, describeCoolifyForbidden } from '../integrations/deploy/index.js';

/** Coolify's own refusal, named the same way on both doors; null for anything that is not one. */
export function coolifyRefusal(err: unknown): string | null {
  if (!(err instanceof CoolifyApiError)) return null;
  return err.status === 403
    ? describeCoolifyForbidden(err)
    : `Coolify answered HTTP ${err.status} to ${err.route ?? 'the request Forge made'}`;
}

/** The keys a caller set, so an absent option stays absent rather than an explicit undefined. */
export function given<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
