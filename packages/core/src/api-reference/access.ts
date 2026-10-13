import {
  type PatExclusionDoor,
  type PatPermission,
  type PatReach,
  patPrefixForPath,
  patUngrantableFor,
} from '../auth/pat-permissions.js';
import { scopeForMethod } from '../middleware/pat-rest-surface.js';

/** What a route asks of whoever calls it, read from the maps the gate itself reads. */
export type Access =
  | {
      readonly door: 'token';
      /** The grant a personal or agent token must hold for this method on this path. */
      readonly permission: PatPermission;
      readonly reach: PatReach;
    }
  | {
      readonly door: PatExclusionDoor;
      /** The `PAT_UNGRANTABLE` entry that keeps a token out, and why. */
      readonly pattern: string;
      readonly reason: string;
      readonly instead: string;
    };

/** The access a method and path is held to, or null where the path is in neither `PAT_UNGRANTABLE` nor the grant menu. */
export function accessOf(method: string, path: string): Access | null {
  const excluded = patUngrantableFor(path, method);
  if (excluded) {
    return {
      door: excluded.admits,
      pattern: excluded.pattern,
      reason: excluded.reason,
      instead: excluded.instead,
    };
  }
  const covered = patPrefixForPath(path);
  if (!covered) return null;
  return {
    door: 'token',
    permission: `${covered.resource}:${scopeForMethod(method)}`,
    reach: covered.reach,
  };
}
