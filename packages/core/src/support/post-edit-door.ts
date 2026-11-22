// The one door every in-place edit of a bot message in a room goes through (ISS-1417). agenfold's
// owner group, 2026-11-22: the room agent's 09:38 reply was rewritten at 10:08 into the 0.310.0
// release-check report, because the master's post took the thread's latest bot message as the
// answer to replace, and the owner never read the answer he asked for. So an edit names who makes
// it, and the message's own record decides whether that editor may: a master edits only a post it
// made (`master-post-edit.ts`), a report only its own earlier post of the same report
// (`report-post.ts`), and one voice replaces only the thread's current answer, never a report
// (`one-voice.ts`). Anything else is refused by name and the room is left as it was.

import type { ProvenMessage } from '@forge/contracts/messaging';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { editProvenReply } from '../integrations/rocketchat/index.js';
import { no, type Outcome } from './outcome.js';
import type { ActionRow, RoomRow } from './store.js';
import { roomAuth } from './thread.js';

/** The tool a master's post is recorded under (`master-post.ts:TOOL`). */
const MASTER_POST = 'master_post';

/** Who edits a bot message, and on what claim. */
export type Editor =
  /** A master editing a post it made through master-posts, for its project. */
  | { kind: 'own-post'; projectId: string; by: string }
  /** A master's post replacing the bot's answer to the thread's current request (ISS-1243). */
  | { kind: 'one-voice' }
  /** A report updating in place its own earlier post of the same report (ISS-1417). */
  | { kind: 'report'; projectId: string; report: string };

type PostInput = { by?: unknown; for?: unknown; report?: unknown };

const inputOf = (r: ActionRow) => (r.input ?? {}) as PostInput;

/** A master's post: routed into a thread or announced in a report thread. */
export const isMasterPost = (r: ActionRow) =>
  r.tool === MASTER_POST && (r.kind === 'routed' || r.kind === 'announced');

/** The report a master's post is, or null where it is an answer. */
export function reportOf(r: ActionRow): string | null {
  const report = inputOf(r).report;
  return isMasterPost(r) && typeof report === 'string' ? report : null;
}

/** The project a master's post was made for: its `for`, else the room's. */
const madeFor = (r: ActionRow) => {
  const given = inputOf(r).for;
  return typeof given === 'string' ? given : r.projectId;
};

const isAgentReply = (r: ActionRow) => r.kind === 'reply' && r.actorKind === 'session';

/** Every record naming chat message `messageId`, oldest first. */
export async function recordsOfMessage(messageId: string): Promise<ActionRow[]> {
  return db
    .select()
    .from(supportActions)
    .where(eq(supportActions.externalId, messageId))
    .orderBy(asc(supportActions.createdAt));
}

/** What the message shows now, by its newest record that put words in it. */
function speakerOf(records: readonly ActionRow[]): ActionRow | null {
  return records.filter((r) => isAgentReply(r) || isMasterPost(r)).at(-1) ?? null;
}

/** Whose message it is, as a refusal says it. */
function whose(speaker: ActionRow | null): string {
  if (!speaker) return 'a message core holds no record of';
  if (isAgentReply(speaker)) return "the room agent's reply";
  const report = reportOf(speaker);
  return report ? `the report "${report}" of project ${madeFor(speaker)}` : "a master's post";
}

/** Why `editor` may not edit message `messageId` of these records, or null where it may. */
export function editRefusal(
  records: readonly ActionRow[],
  messageId: string,
  editor: Editor,
): Outcome<never> | null {
  const speaker = speakerOf(records);
  const may =
    speaker !== null &&
    (editor.kind === 'one-voice'
      ? isAgentReply(speaker) || (isMasterPost(speaker) && reportOf(speaker) === null)
      : editor.kind === 'report'
        ? reportOf(speaker) === editor.report && madeFor(speaker) === editor.projectId
        : isMasterPost(speaker) &&
          madeFor(speaker) === editor.projectId &&
          inputOf(speaker).by === editor.by);
  if (may) return null;
  const as =
    editor.kind === 'report'
      ? `the report "${editor.report}", which edits only its own earlier post`
      : editor.kind === 'one-voice'
        ? "a master's post, which replaces only the thread's current answer"
        : 'a master, which edits only its own post';
  return no(
    'SUPPORT_EDIT_NOT_ITS_OWN',
    '/messageId',
    `message ${messageId} is ${whose(speaker)}, and ${as}. Nothing was changed in the room.`,
  );
}

/** An edit made, refused by the door by name (`refused`), or refused by the chat server (`why`). */
export type EditOutcome =
  | { ok: true }
  | { ok: false; refused: Outcome<never> }
  | { ok: false; why: string };

/**
 * Replace the text of bot message `messageId` in `room`, where its record lets `editor` edit it:
 * refused by name otherwise (`refused`), or where the chat server would not (`why`).
 */
export async function editBotPost(input: {
  room: RoomRow;
  messageId: string;
  text: string;
  proof: ProvenMessage;
  editor: Editor;
}): Promise<EditOutcome> {
  const refused = editRefusal(
    await recordsOfMessage(input.messageId),
    input.messageId,
    input.editor,
  );
  if (refused) return { ok: false, refused };
  const { auth } = await roomAuth(input.room);
  return editProvenReply(auth, input.room.rid, input.messageId, input.text, input.proof);
}
