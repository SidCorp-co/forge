import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterRefusal,
  MasterSlots,
  MasterStanding,
} from '@forge/contracts/master-standing';
import { MASTER_JOB_PANES_MAX } from '@forge/contracts/master-standing';
import { atLeastVersion } from '../runners/device-cap.js';

// cm:hack ISS-107 until:every bound runner reports agent_version >= MASTER_SLOTS_MIN_RUNNER — a runner that
// predates the declaration registers its master with no maxJobPanes on every sweep; refusing it would stop
// every live master within the 10-minute reap, so it registers and its slots read undeclared
export const MASTER_SLOTS_MIN_RUNNER = '0.18.0';

export function predatesSlotDeclaration(agentVersion: string | null | undefined): boolean {
  if (!agentVersion || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(agentVersion)) return false;
  return !atLeastVersion(agentVersion, MASTER_SLOTS_MIN_RUNNER);
}

export function slotsUndeclaredRefusal(args: {
  maxJobPanes: number | undefined;
  agentVersion: string | null;
}): MasterRefusal | null {
  if (args.maxJobPanes !== undefined) return null;
  if (predatesSlotDeclaration(args.agentVersion)) return null;
  return {
    code: 'MASTER_SLOTS_UNDECLARED',
    path: '/maxJobPanes',
    detail: `a master session declares how many job panes its box runs at once: send maxJobPanes, a whole number from 1 to ${MASTER_JOB_PANES_MAX} (the runner's [runner] max_job_panes). Core holds no default, so a box that declares none cannot register a master (runner ${args.agentVersion ?? 'version unknown'})`,
  };
}

const passName = (p: Pick<MasterOpenPass, 'verb' | 'startedAt' | 'issueKey'>) =>
  `the ${p.verb} pass started ${p.startedAt}${p.issueKey ? ` on ${p.issueKey}` : ''}`;

export function passAlreadyOpenRefusal(open: MasterOpenPass | null): MasterRefusal | null {
  if (!open) return null;
  return {
    code: 'MASTER_PASS_ALREADY_OPEN',
    path: '/op',
    detail: `this master already has ${passName(open)} open; close it ({ op: "close", sessionId, dispatched, skipped, parked }) before opening the next`,
  };
}

export function passNotOpenRefusal(last: MasterClosedPass | null): MasterRefusal {
  return {
    code: 'MASTER_PASS_NOT_OPEN',
    path: '/op',
    detail: last
      ? `this master has no pass open to close: its last, ${passName(last)}, ended ${last.endedAt}. Open one with { op: "open", sessionId, verb } first`
      : 'this master has never opened a pass, so there is none to close. Open one with { op: "open", sessionId, verb } first',
  };
}

export function sessionEndedRefusal(status: string, terminal: boolean): MasterRefusal | null {
  if (!terminal) return null;
  return {
    code: 'MASTER_SESSION_ENDED',
    path: '/sessionId',
    detail: `this master session is ${status}, so it opens no pass; register the master again (POST /api/devices/me/master-session) and open the pass on the session that answers`,
  };
}

export function undeclaredSlots(deviceName: string): MasterRefusal {
  return {
    code: 'MASTER_SLOTS_UNDECLARED',
    path: '/slots/max',
    detail: `${deviceName} has not declared max_job_panes; the runner declares it when it registers its master, and core holds no default, so the cap is not known`,
  };
}

export function slotsOf(
  device: { name: string; maxJobPanes: number | null },
  inUse: number,
): MasterSlots {
  return {
    inUse,
    max: device.maxJobPanes,
    undeclared: device.maxJobPanes === null ? undeclaredSlots(device.name) : null,
  };
}

export const NO_MASTER_SLOTS =
  'No live master serves this project, so no box has declared slots for it.';

export function slotsNoteOf(standing: Pick<MasterStanding, 'slots'>): string | null {
  if (!standing.slots) return NO_MASTER_SLOTS;
  return standing.slots.undeclared?.detail ?? null;
}
