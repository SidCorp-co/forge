import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterRefusal,
  MasterSlots,
  MasterStanding,
} from '@forge/contracts/master-standing';
import { MASTER_JOB_PANES_MAX } from '@forge/contracts/master-standing';

export function slotsUndeclaredRefusal(args: {
  maxJobPanes: number | undefined;
  agentVersion: string | null;
}): MasterRefusal | null {
  if (args.maxJobPanes !== undefined) return null;
  return {
    code: 'MASTER_SLOTS_UNDECLARED',
    path: '/maxJobPanes',
    detail: `a master session declares how many job panes its box runs at once: send maxJobPanes, a whole number from 1 to ${MASTER_JOB_PANES_MAX} (the runner's [runner] max_job_panes). Core holds no default, so a box that declares none cannot register a master (runner ${args.agentVersion ?? 'version unknown'})`,
  };
}

const passName = (p: Pick<MasterOpenPass, 'verb' | 'startedAt' | 'issueKey'>) =>
  `the ${p.verb} pass started ${p.startedAt}${p.issueKey ? ` on ${p.issueKey}` : ''}`;

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/master_pass.rs:named_pass_id — the runner reads the
// open pass's id from `id <uuid>` in this detail to close a pass whose open answer it never received
export function passAlreadyOpenRefusal(open: MasterOpenPass | null): MasterRefusal | null {
  if (!open) return null;
  return {
    code: 'MASTER_PASS_ALREADY_OPEN',
    path: '/op',
    detail: `this master already has ${passName(open)} open, id ${open.id}; close it ({ op: "close", sessionId, passId, dispatched, skipped, parked }) before opening the next`,
  };
}

export function passNotOpenRefusal(args: {
  passId: string;
  named: MasterClosedPass | null;
  open: MasterOpenPass | null;
}): MasterRefusal {
  const now = args.open
    ? ` The pass open now is ${passName(args.open)}, id ${args.open.id}.`
    : ' No pass is open; open one with { op: "open", sessionId, verb } first.';
  return {
    code: 'MASTER_PASS_NOT_OPEN',
    path: '/passId',
    detail: args.named
      ? `${passName(args.named)} ended ${args.named.endedAt}, and a closed pass is final, so this close changed nothing.${now}`
      : `this master has no pass ${args.passId}.${now}`,
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
