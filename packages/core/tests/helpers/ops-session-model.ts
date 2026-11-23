// The session model the operations e2e drives its rooms with (REQ-75 r4 BC-20..BC-24): each member's
// `do {…}` command is the act the session takes, answered in the thread; kept apart from the test so
// the file stays one screen of behaviour (ISS-1432 grew it past the file-length bar).

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { rows } from './factories.js';
import type { MemberName, OpsChat, RoomName } from './ops-chat-server.js';
import type { SessionBox } from './support-session-box.js';

export const BABO = {
  name: 'babo',
  persona:
    'You are Babo. You coordinate Forge and delivery for the team: projects, issues, runners, masters and releases. You never decide product direction.',
  grants: ['read', 'deliver'],
};
export const SY = {
  name: 'sy',
  persona:
    'You are Sy. You work on product direction, requirements, feedback and research, as drafts a person decides. You never move delivery.',
  grants: ['read', 'draft', 'research'],
};

/** The acts that name the thread they are taken for. */
const THREADED = new Set([
  'move',
  'draft_requirement',
  'draft_feedback',
  'research',
  'record',
  'decide',
]);
/** The acts that run as the member whose message asked for them, naming it (ISS-716). */
const ASKED = new Set(['move', 'draft_requirement', 'draft_feedback']);
/** What a member writes into a thread while a turn works on another member's command there. */
const INTERJECTION = 'hmm, wait';

/** The model: acts each `do {…}` command and records the tool's answer per thread in `answered`. */
export function opsModel(
  chat: OpsChat,
  answered: Map<string, Record<string, unknown>>,
): SessionBox['model'] {
  return async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from !== 'forge' && m.text === INTERJECTION) {
        await act({ action: 'reply', thread: m.thread, text: 'noted' });
        continue;
      }
      if (m.from === 'forge' || !m.text.startsWith('do ')) continue;
      // `interject` has a member write in the thread before the act runs; `name` has the session
      // name another thread and message than the one it was handed, as a confused session would
      const {
        interject,
        name,
        ...args
      }: Record<string, unknown> & {
        interject?: { who: MemberName; room: RoomName };
        name?: { thread: string; message: string };
      } = JSON.parse(m.text.slice(3));
      if (interject) {
        const id = await chat.say(interject.who, interject.room, INTERJECTION, m.thread);
        await expect
          .poll(
            async () =>
              (await rows(sql`SELECT 1 FROM support_actions WHERE external_id = ${id}`)).length,
          )
          .toBe(1);
      }
      const out = await act({
        ...args,
        ...(THREADED.has(String(args.action)) ? { thread: name?.thread ?? m.thread } : {}),
        ...(ASKED.has(String(args.action)) ? { message: name?.message ?? m.message } : {}),
      });
      answered.set(m.thread, out);
      await act({ action: 'reply', thread: m.thread, text: out.isError ? 'refused' : 'done' });
    }
  };
}
