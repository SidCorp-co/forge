// What a room agent's look holds beyond the screen's words (ISS-1386): the testing-profile actor's
// session placed in the box's browser before the screen is read, and the screen's picture kept on
// the room's session as an upload the agent's reply names (`support.reply { shots }`).
//
// The session goes to the box as core's own acts, recorded in the box's feed with each value shown
// as `SESSION_SHOWN` and with no output kept (`boxes/acts.ts`). The password never leaves core:
// `project-config/look-sign-in.ts` spends it on the sign-in alone.

import type { SupportLookView } from '@forge/contracts/support-look';
import { persistSessionAttachment } from '../agent-sessions/index.js';
import { agentAct, boxShot, SESSION_SHOWN } from '../boxes/index.js';
import { RefusalError } from '../lib/refusal.js';
import type { BrowserSession, LookSignIn } from '../project-config/index.js';
import type { RoomRow } from './store.js';

type BoxActor = Parameters<typeof agentAct>[0];

/** One act of the session's placement: what the device runs, and what the feed shows of it. */
interface SessionStep {
  run: string[];
  shown: string[];
}

/** The acts that put `session` in the box's browser, then open `url` signed in. */
export function sessionSteps(session: BrowserSession, url: string): SessionStep[] {
  const steps: SessionStep[] = session.cookies.map((c) => {
    const flags = [
      '--url',
      c.url,
      ...(c.domain ? ['--domain', c.domain] : []),
      '--path',
      c.path,
      ...(c.httpOnly ? ['--http-only'] : []),
      ...(c.secure ? ['--secure'] : []),
      ...(c.sameSite ? ['--same-site', c.sameSite] : []),
    ];
    return {
      run: ['cookies', 'set', c.name, c.value, ...flags],
      shown: ['cookies', 'set', c.name, SESSION_SHOWN, ...flags],
    };
  });
  if (session.storage) {
    steps.push({ run: ['open', session.storage.origin], shown: ['open', session.storage.origin] });
    for (const [key, value] of session.storage.items) {
      steps.push({
        run: ['storage', 'local', 'set', key, value],
        shown: ['storage', 'local', 'set', key, SESSION_SHOWN],
      });
    }
  }
  steps.push({ run: ['open', url], shown: ['open', url] });
  return steps;
}

/** Place the session in the box; null once it is placed, else why not, naming the act, never a value. */
async function placeSession(
  actor: BoxActor,
  boxId: string,
  session: BrowserSession,
  url: string,
): Promise<string | null> {
  for (const step of sessionSteps(session, url)) {
    const said = step.shown.slice(0, 2).join(' ');
    try {
      const done = await agentAct(actor, boxId, step.run, undefined, step.shown);
      if (done.act.state !== 'done') {
        return `the box's \`${said}\` act ${done.act.state === 'pending' ? 'did not answer in time' : `ended ${done.act.state} (exit ${done.act.exitCode})`}`;
      }
    } catch (err) {
      if (!(err instanceof RefusalError)) throw err;
      return `the box refused its \`${said}\` act (${err.refusals.map((r) => r.code).join(', ')})`;
    }
  }
  return null;
}

/**
 * Sign the box's browser in as `signIn` names, and say who it is signed in as. Null where the
 * environment names no testing profile.
 */
export async function signInBox(
  actor: BoxActor,
  boxId: string,
  signIn: LookSignIn,
  url: string,
  ready: boolean,
): Promise<SupportLookView['signIn']> {
  if (signIn.kind === 'none' || signIn.kind === 'unknown-actor') return null;
  if (signIn.kind === 'unsigned') return { actor: signIn.actor, signedIn: false, why: signIn.why };
  if (!ready) {
    return {
      actor: signIn.actor,
      signedIn: false,
      why: 'the box was still opening, so nothing signed it in; take a new first look once it answers',
    };
  }
  const why = await placeSession(actor, boxId, signIn.session, url);
  return { actor: signIn.actor, signedIn: why === null, why };
}

/**
 * The screen's picture kept on the room's session, by its upload id; null where the room runs no
 * session or the box sent no picture. It is the room's alone: a reply names it only in its thread.
 */
export async function keepShot(room: RoomRow, boxId: string): Promise<string | null> {
  if (!room.sessionId) return null;
  const shot = await boxShot(boxId);
  if (!shot.ok) return null;
  try {
    const kept = await persistSessionAttachment({
      sessionId: room.sessionId,
      name: `look-${boxId.slice(0, 8)}.${shot.mime === 'image/png' ? 'png' : 'jpg'}`,
      mime: shot.mime,
      bytes: shot.bytes,
      uploaderId: room.principalUserId,
      uploaderDeviceId: null,
    });
    return kept.id;
  } catch (err) {
    if (err instanceof RefusalError) return null;
    throw err;
  }
}
