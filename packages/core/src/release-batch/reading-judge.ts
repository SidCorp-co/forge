// Whether the readings recorded on a release show it live (ISS-1282). Pure: no read of the
// probes, no clock but the one it is handed. The close judges readings Forge stored, so what the
// agent says about the deploy is not an input here.
//
// Each live binding that declares a probe is judged on its own readings, and the roster closes
// only where every one of them is believed. The rule one reading is judged by is
// `verify.ts:readingSatisfies`, which is the rule the polling loop applied; what is new is that the
// reads it was applied to were taken when the agent asked, and are kept.

import type { BindingReading, CommitsBefore, ReleaseReading } from './readings.js';
import { failureFor, NOTHING_TO_COMPARE, readingSatisfies } from './verify.js';

/**
 * How old a reading may be and still say what is serving now. A bound on the age of evidence and
 * not on the length of a wait: a deploy followed by another deploy cannot be certified by what the
 * first one left behind, and nothing here decides for the agent when the deploy is done.
 */
export const RELEASE_READING_MAX_AGE_MS = 15 * 60_000;

/** A live binding the close reads: how it is named and how many consecutive readings believe it. */
export interface JudgedBinding {
  bindingId: string;
  name: string;
  /** The probes the binding declares now; a reading taken with others is not evidence of them. */
  probes: string;
  stableReads: number;
}

export interface JudgeInput {
  bindings: readonly JudgedBinding[];
  /** Every reading of the run, oldest first. */
  readings: readonly ReleaseReading[];
  commitsBefore: CommitsBefore;
  /** The whole sha the release says it pushed, or `null` to ask only that the build moved. */
  claim: string | null;
  now: number;
}

export type Judgement =
  | {
      ok: true;
      /** Whether any binding now serves something other than what it served when the batch opened. */
      moved: boolean;
      /** What the first binding serves; every binding confirmed the claim or moved. */
      identity: string;
      /** The readings the close rests on, oldest first. */
      evidence: string[];
    }
  | { ok: false; reason: string; live: string | null };

type BindingJudgement =
  | { ok: true; identity: string; moved: boolean; evidence: string[] }
  | { ok: false; reason: string; live: string | null };

interface Kept {
  id: string;
  takenAt: number;
  state: BindingReading['state'];
}

const minutes = (ms: number) => Math.round(ms / 60_000);

function judgeBinding(
  binding: JudgedBinding,
  kept: readonly Kept[],
  before: string | null,
  claim: string | null,
  now: number,
  elsewhere: number,
): BindingJudgement {
  const { name } = binding;
  const newest = kept.at(-1);
  if (newest === undefined) {
    return {
      ok: false,
      live: null,
      reason:
        elsewhere > 0
          ? `the probes declared for ${name} are not the ones its ${elsewhere} recorded reading(s) were taken with, so they say nothing about what these serve — call \`look\`, then finish`
          : `no reading of ${name} is recorded on this batch, so nothing says what it is serving — call \`look\` once the deploy has landed, then finish`,
    };
  }
  const live = newest.state.identity;
  const age = now - newest.takenAt;
  if (age > RELEASE_READING_MAX_AGE_MS) {
    return {
      ok: false,
      live,
      reason: `the newest reading of ${name} is ${minutes(age)} minutes old, and a reading older than ${minutes(RELEASE_READING_MAX_AGE_MS)} minutes says nothing about what is serving now — call \`look\` again, then finish`,
    };
  }
  if (claim === null && before === null) return { ok: false, live, reason: NOTHING_TO_COMPARE };
  if (!readingSatisfies(live, before, claim)) {
    return { ok: false, live, reason: failureFor(newest.state, before, claim).reason };
  }
  const recent = kept.slice(-binding.stableReads);
  if (recent.length < binding.stableReads) {
    return {
      ok: false,
      live,
      reason: `${recent.length} of the ${binding.stableReads} consecutive readings of ${name} that this release is believed on are recorded, the newest showing ${live} — call \`look\` again`,
    };
  }
  const identities = [...new Set(recent.map((r) => r.state.identity))];
  const unsteady = recent.some((r) => !readingSatisfies(r.state.identity, before, claim));
  if (unsteady || identities.length > 1) {
    return {
      ok: false,
      live,
      reason: `the last ${binding.stableReads} readings of ${name} do not all show the build this release pushed (${identities.map((i) => i ?? 'no commit').join(', ')}) — a rollout still moving, so call \`look\` again once it has settled`,
    };
  }
  return {
    ok: true,
    identity: live as string,
    moved: live !== before,
    evidence: recent.map((r) => r.id),
  };
}

/**
 * The newest unbroken run of this binding's readings taken with the probes it declares now, oldest
 * first, and how many of its readings fall outside it: one taken with other probes ends the run.
 */
function keptFor(
  binding: JudgedBinding,
  readings: readonly ReleaseReading[],
): { kept: Kept[]; elsewhere: number } {
  const own = readings.flatMap((r) => {
    const reading = r.bindings.find((b) => b.bindingId === binding.bindingId);
    return reading ? [{ id: r.id, takenAt: r.takenAt.getTime(), reading }] : [];
  });
  const kept: Kept[] = [];
  for (const { id, takenAt, reading } of own.reverse()) {
    if (reading.probes !== binding.probes) break;
    kept.unshift({ id, takenAt, state: reading.state });
  }
  return { kept, elsewhere: own.length - kept.length };
}

export function judgeReadings(input: JudgeInput): Judgement {
  const { bindings, readings, commitsBefore, claim, now } = input;
  // Nothing to judge is nothing proved: an empty set answering "ok" would close a roster on no read.
  if (bindings.length === 0) throw new Error('judgeReadings: no binding was named to judge');
  const judged = bindings.map((binding) => {
    const { kept, elsewhere } = keptFor(binding, readings);
    const before = commitsBefore[binding.bindingId] ?? null;
    return { binding, verdict: judgeBinding(binding, kept, before, claim, now, elsewhere) };
  });
  const refused = judged.flatMap(({ binding, verdict }) =>
    verdict.ok ? [] : [{ binding, verdict }],
  );
  if (refused.length > 0) {
    const prefix = (name: string) => (bindings.length > 1 ? `${name}: ` : '');
    return {
      ok: false,
      live: refused[0]?.verdict.live ?? null,
      reason: refused
        .map(({ binding, verdict }) => `${prefix(binding.name)}${verdict.reason}`)
        .join('; '),
    };
  }
  const confirmed = judged.flatMap(({ verdict }) => (verdict.ok ? [verdict] : []));
  return {
    ok: true,
    moved: confirmed.some((v) => v.moved),
    identity: confirmed[0]?.identity as string,
    evidence: [...new Set(confirmed.flatMap((v) => v.evidence))],
  };
}
