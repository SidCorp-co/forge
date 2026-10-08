import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterRefusal,
  MasterSlots,
} from '@forge/contracts/master-standing';
import { MASTER_JOB_PANES_MAX } from '@forge/contracts/master-standing';
import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';

// the wire calls a refusal names, kept out of the sentence so a reader's language never rewrites them
const SETTLE_CALL = '{ op: "settle", sessionId, passId, facts }';
const OPEN_CALL = '{ op: "open", sessionId, verb }';

/** A master refusal whose English detail is the sentence it says. */
const refusal = (code: MasterRefusal['code'], path: string, detail: Said): MasterRefusal => ({
  code,
  path,
  detail: sayEn(detail),
  says: { detail },
});

export function slotsUndeclaredRefusal(args: {
  maxJobPanes: number | undefined;
  agentVersion: string | null;
}): MasterRefusal | null {
  if (args.maxJobPanes !== undefined) return null;
  return refusal(
    'MASTER_SLOTS_UNDECLARED',
    '/maxJobPanes',
    say('masters.refusal.slotsUndeclared', {
      max: MASTER_JOB_PANES_MAX,
      version: args.agentVersion
        ? verbatim(args.agentVersion)
        : say('masters.refusal.versionUnknown'),
    }),
  );
}

const passName = (p: Pick<MasterOpenPass, 'verb' | 'startedAt' | 'issueKey'>) =>
  say('masters.refusal.passName', {
    verb: p.verb,
    at: p.startedAt,
    on: p.issueKey ? say('masters.refusal.passOn', { key: p.issueKey }) : null,
  });

// contract -> packages/runner/crates/runner-daemon/src/master_pass.rs:named_pass_id — the runner reads the
// open pass's id from `id <uuid>` in this detail to settle a pass whose open answer it never received
export function passAlreadyOpenRefusal(open: MasterOpenPass | null): MasterRefusal | null {
  if (!open) return null;
  return refusal(
    'MASTER_PASS_ALREADY_OPEN',
    '/op',
    say('masters.refusal.passAlreadyOpen', {
      pass: passName(open),
      id: open.id,
      settle: SETTLE_CALL,
    }),
  );
}

export function passNotOpenRefusal(args: {
  passId: string;
  named: MasterClosedPass | null;
  open: MasterOpenPass | null;
}): MasterRefusal {
  const now = args.open
    ? say('masters.refusal.passOpenNow', { pass: passName(args.open), id: args.open.id })
    : say('masters.refusal.noPassOpen', { call: OPEN_CALL });
  return refusal(
    'MASTER_PASS_NOT_OPEN',
    '/passId',
    args.named
      ? say('masters.refusal.passEnded', {
          pass: passName(args.named),
          at: args.named.endedAt,
          now,
        })
      : say('masters.refusal.noSuchPass', { id: args.passId, now }),
  );
}

export function sessionEndedRefusal(status: string, terminal: boolean): MasterRefusal | null {
  if (!terminal) return null;
  return refusal(
    'MASTER_SESSION_ENDED',
    '/sessionId',
    say('masters.refusal.sessionEnded', { status }),
  );
}

function undeclaredSlots(deviceName: string): MasterRefusal {
  return refusal(
    'MASTER_SLOTS_UNDECLARED',
    '/slots/max',
    say('masters.refusal.slotsNotDeclared', { device: deviceName }),
  );
}

// max_job_panes caps the job panes the daemon opens for pool jobs (runner master/pool_take.rs); a run a
// master declares for its own in-pane builder takes no job pane, so it is counted beside the slots
export function slotsOf(
  device: { name: string; maxJobPanes: number | null },
  held: { jobPanes: number; runs: number },
): MasterSlots {
  return {
    inUse: held.jobPanes,
    max: device.maxJobPanes,
    runs: held.runs,
    undeclared: device.maxJobPanes === null ? undeclaredSlots(device.name) : null,
  };
}

export { NO_MASTER_SLOTS, slotsNoteOf } from '@forge/contracts/master-standing';
