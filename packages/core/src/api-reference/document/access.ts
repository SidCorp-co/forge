import {
  type PatExclusionDoor,
  type PatPermission,
  type PatReach,
  patPrefixForPath,
  patUngrantableFor,
} from '../../auth/pat-permissions.js';
import { scopeForMethod } from '../../middleware/pat-rest-surface.js';
import { sentence } from '../declare/prose.js';

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

/** The doors whose routes take no bearer at all, whatever gates the route runs. */
const BEARERLESS_DOORS: ReadonlySet<string> = new Set(['public', 'ticket', 'signature']);

/**
 * Whether a caller sends a bearer to this route. The door says what a token meets and the gates
 * the route runs say what it reads: a route its door admits to a session or a box may still read
 * no bearer at all (a sign-in, a pairing), and one shown asking for a credential it never reads
 * sends a person to the wrong step. The MCP door is its own gate and declares nothing, so it is
 * read by name.
 */
export function asksForBearer(access: Access | null, gatesTakeBearer: boolean): boolean {
  if (!access || BEARERLESS_DOORS.has(access.door)) return false;
  return access.door === 'mcp' || gatesTakeBearer;
}

/**
 * What a person reading the page is told about the grant and the door, at the head of the
 * operation: the permission a token needs, or the door that keeps a token out and why. A program
 * reads the same facts from `x-forge-access`.
 */
export function accessProse(access: Access | null, gatesTakeBearer: boolean): string {
  if (!access) return '';
  const paragraphs: string[] = [];
  if (access.door === 'token') {
    const reach =
      access.reach === 'project'
        ? 'A token fenced to projects can use this route.'
        : "Only a token that carries its owner's whole reach can use this route.";
    paragraphs.push(
      `**Permission:** \`${access.permission}\`. A personal or agent token must be granted it. ${reach}`,
    );
  } else {
    const turnedAway = access.door === 'public' ? '' : 'No permission grants a token this route. ';
    paragraphs.push(
      `**Door:** \`${access.door}\`. ${turnedAway}${sentence(access.reason)} ${sentence(access.instead)}`,
    );
  }
  if (!BEARERLESS_DOORS.has(access.door) && !asksForBearer(access, gatesTakeBearer)) {
    paragraphs.push('**Credential:** none. This route reads no bearer.');
  }
  return paragraphs.join('\n\n');
}
