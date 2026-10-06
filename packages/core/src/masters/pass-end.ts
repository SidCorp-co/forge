import type {
  MasterPassCloseReason,
  MasterPassFacts,
  MasterPassRefusal,
} from '@forge/contracts/master-standing';
import { SESSION_SILENCE_TIMEOUT_MS } from '../devices/index.js';

/** How a pass ended, why, and the refusal it closes with where its turn met one before anything ran. */
export interface PassEnd {
  reason: MasterPassCloseReason;
  because: string;
  refused: MasterPassRefusal | null;
}

const BECAUSE: Record<Exclude<MasterPassCloseReason, 'turn_ended'>, string> = {
  abandoned_restart:
    'opened by the daemon process before the one that reports it, so the hook counts its turn was measured against are gone and the turn can no longer be judged; closed as abandoned at the restart',
  abandoned_orphan:
    'core held it open with no record on the box (an open whose answer never arrived); closed as abandoned',
  unrecorded: 'the box could not record core opening it, so nothing there would ever close it',
  session_gone:
    'its master session is no longer the one the box serves the project under; closed with the session',
  abandoned_quiet: `abandoned: its master reported no hook and wrote no transcript for ${SESSION_SILENCE_TIMEOUT_MS / 60_000}m, so its turn can no longer be told from a pane idle at its prompt; it stops holding nudges`,
};

const ended = (reason: Exclude<MasterPassCloseReason, 'turn_ended'>): PassEnd => ({
  reason,
  because: BECAUSE[reason],
  refused: null,
});

/**
 * Whether the turn the pass covers has ended: a turn counted after the pass was asked for, begun
 * no earlier than the pass opened, and over. A task-notification turn already running when a nudge
 * was typed ends before the nudge's own prompt is taken, and is not the nudged turn.
 */
function turnEnded(facts: MasterPassFacts): boolean {
  const { hooks } = facts;
  if (!hooks || hooks.turnsSinceOpen === 0 || hooks.turnBeganAgoMs === null) return false;
  return (
    hooks.turnBeganAgoMs <= facts.openedAgoMs &&
    (hooks.doing === 'idle' || hooks.doing === 'awaiting_children')
  );
}

/**
 * Whether nothing has come from the pass's master — no hook, no transcript write, nothing since the
 * pass opened — for the silence core calls a master silent after. A pane stopped on a question a
 * person owes is waiting, not quiet: the nudge the pass would stop holding would be typed into it.
 */
function quiet(facts: MasterPassFacts): boolean {
  if (facts.hooks?.doing === 'awaiting_permission') return false;
  const sinceLife = Math.min(
    facts.openedAgoMs,
    facts.hooks?.lastEventAgoMs ?? Number.POSITIVE_INFINITY,
    facts.writtenAgoMs ?? Number.POSITIVE_INFINITY,
  );
  return sinceLife >= SESSION_SILENCE_TIMEOUT_MS;
}

/**
 * The refusal a pass closes with: only one inside which nothing ran — no answer from the account
 * and no run declared. A refusal met after work is the end of a turn that ran.
 */
function refusedBefore(facts: MasterPassFacts): MasterPassRefusal | null {
  if (facts.record.worked || facts.dispatched.length > 0) return null;
  return facts.record.refusal;
}

/** How the pass ended, or null while it stands (design agent-run-standing rev 1, region master). */
export function passEnd(facts: MasterPassFacts): PassEnd | null {
  if (facts.openedBy === 'adopted') return ended('abandoned_orphan');
  if (facts.openedBy === 'unrecorded') return ended('unrecorded');
  if (facts.openedBy === 'earlier_daemon') return ended('abandoned_restart');
  if (!facts.served) return ended('session_gone');
  if (turnEnded(facts)) {
    return {
      reason: 'turn_ended',
      because: 'the turn it covers has ended',
      refused: refusedBefore(facts),
    };
  }
  if (quiet(facts)) return ended('abandoned_quiet');
  return null;
}
