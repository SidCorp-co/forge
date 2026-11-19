// `secret_link`: the one secret door a room agent gives a person (ISS-1328, ISS-1348). The agent names
// the slot — a variable at one environment, a testing profile's actor or service, or an integration's
// credential — of the room's project or another its room reaches (ISS-1346), and core builds the link
// that opens that one field with its key, scope and kind filled and its value box focused. With
// `presign`, the same act answers a one-time write URL for that slot alone, for a value that lives in a
// file or a terminal: PUT the value as the body, within `SECRET_WRITE_TTL_MINUTES`, once; it writes
// and reads nothing. The ask is recorded, so a value saved through either door is told to this thread
// by fingerprint (`secret-receipts.ts`). The value never passes through chat, a turn or a transcript.
// Core posts nothing: the session gives the link in its own words.

import type { SupportSecretLinkRequest } from '@forge/contracts/support';
import { webBaseUrl } from '../lib/web-base-url.js';
import { namedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { recordAsk, SECRET_WRITE_TTL_MINUTES } from './secret-asks.js';
import { resolveSlot } from './secret-slots.js';
import type { RoomRow } from './store.js';

export { secretLinkOf } from './secret-slots.js';

/** The one-time write URL of an ask, and the command a person runs where the value lives. */
export interface SecretWrite {
  url: string;
  method: 'PUT';
  expiresAt: string;
  minutes: number;
  command: string;
}

export interface SecretLink {
  link: string;
  project: string;
  kind: SupportSecretLinkRequest['kind'];
  slot: Record<string, string | null>;
  /** Whether the slot holds a value now: the person replaces it there. */
  held: boolean;
  write?: SecretWrite;
  /** Who the link opens a value field for. */
  opensFor: string;
  says: string;
}

/** The write URL a token opens, with the command that PUTs a file's contents there. */
export function secretWriteOf(web: string, token: string, expiresAt: Date): SecretWrite {
  const url = `${web}/api/secret-writes/${token}`;
  return {
    url,
    method: 'PUT',
    expiresAt: expiresAt.toISOString(),
    minutes: SECRET_WRITE_TTL_MINUTES,
    command: `curl -X PUT --data-binary @<file holding the value> '${url}'`,
  };
}

const OPENS_FOR: Record<SupportSecretLinkRequest['kind'], (slug: string) => string> = {
  variable: (slug) => `a person signed in to Forge who manages ${slug}'s variables (env.manage)`,
  testing: (slug) =>
    `a person signed in to Forge who edits ${slug}'s settings: an owner or admin of its organization`,
  integration: () => 'a person signed in to Forge who manages that connection',
};

function says(write: boolean): string {
  return [
    'Give this link as the place to enter the value: it opens that one field, and the value is kept in Forge’s vault, never in chat.',
    write
      ? `Where the value sits in a file or a terminal, give the command too: it sets the slot once and only within ${SECRET_WRITE_TTL_MINUTES} minutes, and reads nothing.`
      : 'Where the value sits in a file or a terminal, ask again with presign: true for a one-time write URL.',
    'You will be told in this thread, by fingerprint, once it holds a value; never ask for the value in chat, never write a settings address by hand, and never ask anyone to rotate it.',
  ].join(' ');
}

export async function secretLink(
  room: RoomRow,
  input: SupportSecretLinkRequest,
): Promise<Outcome<SecretLink>> {
  if (!(await knownThread(room, input.thread))) return threadUnknown(input.thread);
  const project = await namedProject(room, undefined);
  if (!project.ok) return project;
  const slot = await resolveSlot(project.value, input);
  if (!slot.ok) return slot;
  const web = webBaseUrl();
  if (!web) {
    return no(
      'SUPPORT_SECRET_LINK_NO_WEB',
      '',
      'this Forge knows no address of its web app (CORS_ORIGINS is unset), so it has no page to link to; ask the master with support.ask_master. No link was made.',
    );
  }
  const link = `${web}${slot.value.path}`;
  const { row, token } = await recordAsk(
    {
      projectId: project.value.id,
      roomId: room.id,
      thread: input.thread,
      kind: slot.value.kind,
      slot: slot.value.slot,
      slotKey: slot.value.slotKey,
      link,
    },
    input.presign === true,
  );
  return {
    ok: true,
    value: {
      link,
      project: project.value.slug,
      kind: slot.value.kind,
      slot: slot.value.slot,
      held: slot.value.held,
      ...(token && row.writeExpiresAt
        ? { write: secretWriteOf(web, token, row.writeExpiresAt) }
        : {}),
      opensFor: OPENS_FOR[slot.value.kind](project.value.slug),
      says: says(token !== null),
    },
  };
}
