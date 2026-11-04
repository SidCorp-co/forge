// Where a project's row stands on Activity and what its left text says, both from the one master state
// `masters/state.ts:masterStateOf` derived (ISS-951 round 4). Round 3 read the group from that state
// and "busy by hand" from the last pass's trigger, so a master idle since a turn somebody started at
// its pane sat in Idle with backlog beside "busy by hand" (judge run e0121211, Agenfold at dev.486).
// Each reading here says what is true now, and none contradicts the group.

import type {
  OrgActivityDoing,
  OrgActivityGroup,
  OrgActivityProject,
  OrgActivitySkipReason,
} from '@forge/contracts/org-activity';
import type { MasterGlance } from '../masters/index.js';

const RUNNING = new Set(['in_pass', 'busy', 'runs_out']);

/** Where a row stands, by its master and what is owed, never by an in-progress issue (MK-9). */
export function groupOf(
  p: Pick<OrgActivityProject, 'master' | 'next' | 'people' | 'awaitingRelease'>,
): OrgActivityGroup {
  const state = p.master.state;
  if (RUNNING.has(state)) return 'running';
  if (state === 'waiting_person') return 'waiting';
  if (state !== 'none' && p.next.total > 0) return 'idle';
  if (p.people.total > 0 || p.awaitingRelease > 0 || p.next.total > 0) return 'waiting';
  return 'quiet';
}

/**
 * What the master does now, by name: the open pass's verb and issue while it is in that pass (or
 * stopped on a dialog inside it), the issue of its newest run while its runs are out. A silent or
 * idle master, or one busy by hand, does nothing core can name; its row says so by its group.
 */
export function doingOf(
  m: MasterGlance,
  titleOf: (key: string) => string | null,
): OrgActivityDoing | null {
  const named = (key: string | null) => (key ? titleOf(key) : null);
  if (m.pass && (m.state === 'in_pass' || m.state === 'waiting_person')) {
    return {
      kind: 'pass',
      verb: m.pass.verb,
      issueKey: m.pass.issueKey,
      issueTitle: named(m.pass.issueKey),
    };
  }
  if (m.newestRunIssue && m.state === 'runs_out') {
    return {
      kind: 'run',
      verb: null,
      issueKey: m.newestRunIssue,
      issueTitle: named(m.newestRunIssue),
    };
  }
  return null;
}

/**
 * Why the last pass took nothing while a backlog stood, as it reads now: a pane working by hand while
 * no pass is open; its box taking no new run; its runs out or slots full. Null where it took
 * something, where no backlog stands, or where core holds no reason true now: a turn somebody began at
 * the pane that has since ended leaves the master idle, and an idle master is not busy by hand.
 */
export function skipOf(m: MasterGlance | undefined, backlog: number): OrgActivitySkipReason | null {
  if (!m || backlog === 0 || !m.lastPass || m.lastPass.dispatched.length > 0) return null;
  if (m.state === 'busy') return 'busy_by_hand';
  if (m.poolClosed) return 'pool_closed';
  if (m.runsOut > 0 || m.slotsFull) return 'one_at_a_time';
  return null;
}
