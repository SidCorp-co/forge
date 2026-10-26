// Refusals naming what was refused and who may, each who read off `binding-acts.ts`.

import { HTTPException } from 'hono/http-exception';
import { UNNAMED_PERSON } from '../lib/person-name.js';
import { type ProjectRole, WHO_CHANGES, WHO_GRANTS_A_BOX } from './binding-acts.js';
import { providerLabel } from './health-words.js';
import { whoSavesKey } from './held-key.js';
import type { ListedOwner } from './owner-names.js';

/** The connection tier of a binding PATCH, naming who may change what the asker sent (ISS-1421 r26, r27). */
export const keyNotYours = (connection: { ownerType: 'user' | 'org' }) =>
  new HTTPException(403, {
    message: `This binding's connection belongs to ${connection.ownerType === 'org' ? 'an organization' : 'a person'}, so only ${whoSavesKey(connection)} can change its key or its shared settings. Ask one of them.`,
    cause: { code: 'FORBIDDEN' },
  });

const ROLE_HELD: Record<ProjectRole, string> = {
  admin: 'an admin',
  member: 'a member',
  viewer: 'a viewer',
};

/** A binding-tier act, or any act on the project's integrations, from a reader who is not its admin. */
export const notThisProjectsAdmin = (role: ProjectRole, act: string) =>
  new HTTPException(403, {
    message: `You are ${ROLE_HELD[role]} of this project, so you cannot ${act}. Only ${WHO_CHANGES} can, so ask one of them.`,
    cause: { code: 'FORBIDDEN' },
  });

/** A grant that hands a provider's credential to a runner box (ISS-1071 rule 5). */
export const boxGrantNotYours = (provider: string) =>
  new HTTPException(403, {
    message: `Letting agents use ${providerLabel(provider)} hands its credential to the runner box, so only ${WHO_GRANTS_A_BOX} can change it. Ask one of them.`,
    cause: { code: 'FORBIDDEN' },
  });

/** "a, nor b, nor c": each act whole, since an act's own words may hold an "or". */
const noneOf = (acts: readonly string[]): string => acts.join(', nor ');

/** Several refused acts at once, naming who may take every one (ISS-1421 r28, judge-114 on 308). */
export const severalNotYours = (role: ProjectRole, acts: readonly string[], who: string) =>
  new HTTPException(403, {
    message: `You are ${ROLE_HELD[role]} of this project, and you may not ${noneOf(acts)}. Only ${who} can do all of that, so ask one of them.`,
    cause: { code: 'FORBIDDEN' },
  });

/** An organization's own connection, asked of a reader who is not its owner or admin. */
export const orgCredentialNotYours = (act: string) =>
  new HTTPException(403, {
    message: `Only an owner or admin of the organization can ${act} a connection it owns. Make it your own connection instead, or ask one of them.`,
    cause: { code: 'FORBIDDEN' },
  });

/** A connection as a sentence names it: by the name its owner gave it, never by its id. */
function connectionCalled(connection: { displayName: string | null; provider: string }): string {
  const prefix = `${connection.provider} · `;
  const given = connection.displayName?.startsWith(prefix)
    ? connection.displayName.slice(prefix.length)
    : connection.displayName;
  return given?.trim()
    ? `the connection "${given.trim()}"`
    : `this ${connection.provider} connection`;
}

/** What a connection's own door was asked to do, said after "not" and after "can" (ISS-1421 r28). */
export type ConnectionAct = string;

/** The acts a connection PATCH carries, in words: "rename it or re-key it". */
export function connectionPatchAct(patch: {
  displayName?: unknown;
  config?: unknown;
  secrets?: unknown;
  active?: boolean | undefined;
}): ConnectionAct {
  const acts: string[] = [];
  if (patch.displayName !== undefined) acts.push('rename it');
  if (patch.secrets !== undefined) acts.push('re-key it');
  if (patch.config !== undefined) acts.push('change its settings');
  if (patch.active === true) acts.push('turn it on');
  if (patch.active === false) acts.push('turn it off');
  return acts.length > 0 ? acts.join(' or ') : 'change it';
}

/**
 * Who to ask about a person's connection: their name, or where they set none, the row an
 * organization's Members list draws for them, so the reader can find them (ISS-1421 r29).
 */
function askAboutPersons(
  ownerName: string | null,
  listed: ListedOwner | null,
): { owner: string; ask: string } {
  if (ownerName === null) {
    return {
      owner: 'a user who can no longer be found',
      ask: 'an admin of a project it is bound to',
    };
  }
  if (ownerName === UNNAMED_PERSON) {
    return {
      owner: 'a member who has set no name Forge can show',
      ask: listed
        ? `the member listed as "${listed.listed}" under Members in ${listed.orgName}`
        : 'the member who owns it',
    };
  }
  return { owner: ownerName, ask: ownerName };
}

/**
 * A connection the caller sees and may not change: the act, who owns it and who may. A null
 * `ownerName` is an owner that no longer resolves, said so rather than printed as an id.
 */
export const connectionNotManageable = (
  connection: { ownerType: string; displayName: string | null; provider: string },
  ownerName: string | null,
  act: ConnectionAct,
  listed: ListedOwner | null = null,
) => {
  const opening = `You can see ${connectionCalled(connection)} but not ${act}`;
  if (connection.ownerType === 'org') {
    return new HTTPException(403, {
      message:
        `${opening}: it is owned by the organization ${ownerName ?? '(no longer found)'}, and only an ` +
        `owner or admin of ${ownerName ? 'that organization' : 'the organization that owns it'} can ` +
        `${act}. Ask one of them, or create a connection of your own.`,
      cause: { code: 'CONNECTION_NOT_MANAGEABLE' },
    });
  }
  const { owner, ask } = askAboutPersons(ownerName, listed);
  return new HTTPException(403, {
    message: `${opening}: it is owned by ${owner}, and only its owner can ${act}. Ask ${ask}, or create a connection of your own.`,
    cause: { code: 'CONNECTION_NOT_MANAGEABLE' },
  });
};
