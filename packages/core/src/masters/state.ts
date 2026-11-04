// A master's state, derived from what its box said and what core holds about its passes, in one
// place so the project's standing and the workspace's Activity read the same state (ISS-951, VISION:
// state-never-lies). The pane's own hooks are the live signal: a pass core holds open after the pane
// says its turn ended is over, and a pane working with no pass open is driven by hand.

import {
  MASTER_PANE_DOINGS,
  type MasterPane,
  type MasterPaneFacts,
  type MasterState,
} from '@forge/contracts/master-standing';
import { z } from 'zod';

export interface MasterStateFacts {
  silent: boolean;
  lastBeatAt: string | null;
  /** When the pane's open dialog was seen; null where none stands. */
  dialogSeenAt: string | null;
  pass: { startedAt: string } | null;
  lastPassEndedAt: string | null;
  runsOut: number;
  pane: MasterPane | null;
  /** How long a beat stays live (`SESSION_SILENCE_TIMEOUT_S`). */
  silentAfterSeconds: number;
  now: Date;
}

export interface MasterStateRead {
  state: Exclude<MasterState, 'none'>;
  since: string | null;
  /** Whether the open pass still stands: false where the pane said its turn ended after it opened. */
  passStands: boolean;
}

const ms = (iso: string) => new Date(iso).getTime();

/**
 * A pane report its box's beat sent within the silence window. An older one says nothing of now, and
 * neither does one a pass's settle carried (`source: 'pass'`, a box older than the beat): that is
 * what the pane did when the pass ended, so a state read from it would be a claim about now made from
 * a fact about then (ISS-951 round 3: such a row read "Idle" beside a box heartbeat 55 s old while
 * its master worked). Where no live report stands the state is the pass state alone.
 */
export function paneIsLive(
  pane: MasterPane | null,
  silentAfterSeconds: number,
  now: Date,
): boolean {
  return (
    pane !== null &&
    pane.source === 'beat' &&
    now.getTime() - ms(pane.seenAt) <= silentAfterSeconds * 1000
  );
}

const WORKING = new Set<MasterPane['doing']>(['working', 'awaiting_children']);

/**
 * The state and since when. A pass is in progress until the pane, heard after the pass opened,
 * reports itself idle with its last event after the open: that pass's turn ended, and reading it as
 * in a pass until core settles it would say the master works while it waits.
 */
export function masterStateOf(f: MasterStateFacts): MasterStateRead {
  const live = paneIsLive(f.pane, f.silentAfterSeconds, f.now) ? f.pane : null;
  if (f.silent) return { state: 'silent', since: f.lastBeatAt, passStands: f.pass !== null };
  if (f.dialogSeenAt) {
    return { state: 'waiting_person', since: f.dialogSeenAt, passStands: f.pass !== null };
  }
  const ended =
    f.pass !== null &&
    live !== null &&
    live.doing === 'idle' &&
    ms(live.seenAt) > ms(f.pass.startedAt) &&
    ms(live.lastEventAt) > ms(f.pass.startedAt);
  if (f.pass && !ended) return { state: 'in_pass', since: f.pass.startedAt, passStands: true };
  const afterPass = ended && live ? live.lastEventAt : f.lastPassEndedAt;
  if (live && WORKING.has(live.doing)) {
    return { state: 'busy', since: live.turnBeganAt ?? live.seenAt, passStands: false };
  }
  if (f.runsOut > 0) return { state: 'runs_out', since: afterPass, passStands: false };
  return { state: 'idle', since: afterPass, passStands: false };
}

const paneSchema = z.object({
  doing: z.enum(MASTER_PANE_DOINGS),
  lastEventAt: z.string(),
  turnBeganAt: z.string().nullable(),
  writtenAt: z.string().nullable(),
  seenAt: z.string(),
  source: z.enum(['beat', 'pass']),
});

/** The pane facts stored on a master session, or null where none are or they are not that shape. */
export function storedPane(stored: unknown): MasterPane | null {
  const read = paneSchema.safeParse(stored);
  return read.success ? read.data : null;
}

/** The facts a box sent, each age turned into the time it names as core heard them at `now`. */
export function paneFromFacts(
  facts: MasterPaneFacts,
  source: MasterPane['source'],
  now: Date,
): MasterPane {
  const at = (ago: number) => new Date(now.getTime() - ago).toISOString();
  return {
    doing: facts.doing,
    lastEventAt: at(facts.lastEventAgoMs),
    turnBeganAt: facts.turnBeganAgoMs === null ? null : at(facts.turnBeganAgoMs),
    writtenAt: facts.writtenAgoMs === null ? null : at(facts.writtenAgoMs),
    seenAt: now.toISOString(),
    source,
  };
}
