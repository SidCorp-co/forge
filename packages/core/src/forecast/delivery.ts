/**
 * Done as a person means it, pure: the landing forecast, then what the release adds before the
 * change is in their hands. Where production releases on its own, the project's own landed→released
 * durations are sampled trial by trial onto the landing (the same seeded Monte Carlo, the same floor);
 * where a person or the project's master cuts, approves or records the release, the act is named with
 * who owes it by the one rule (`who-owes.ts`, ISS-1058) and no date is given for it
 * (VISION: state-never-lies). Every rule here is a unit test in `delivery.test.ts`.
 */

import {
  type DeliveryForecast,
  FORECAST_HISTORY_FLOOR,
  FORECAST_LABEL,
  FORECAST_TRIALS,
  FORECAST_WINDOW_DAYS,
  type Forecast,
  type ForecastSpan,
  RELEASE_ACT_PERMISSION,
  type ReleaseHolder,
  type ReleaseLeg,
  type ReleaseMode,
} from '@forge/contracts/forecast';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct } from '@forge/contracts/standing';
import type { OwedActKind, OwedBy } from '@forge/contracts/who-owes';
import { percentile, seeded } from './model.js';

const MINUTE = 60_000;

export interface ReleaseFacts {
  mode: ReleaseMode;
  /** The number the next cut takes, named in the act a person owes. */
  nextVersion: string | null;
  /** Who holds the permission the mode's person act takes (`RELEASE_ACT_PERMISSION`), people first; empty for `automatic` or where nobody holds it. */
  holders?: readonly ReleaseHolder[];
  /** Landed→released minutes of the project's issues shipped in the window. */
  lags: readonly number[];
  /** The reader is one who owes the act a person takes here, so the leg names them as "You". */
  viewerOwes?: boolean;
  /**
   * Who owes each release act, by the one rule read with the project's policy and what the draft
   * carries (`release-batch/release-owes.ts`, ISS-1058); absent, every act reads as a person's.
   */
  owes?: (kind: OwedActKind) => OwedBy;
  floor?: number;
}

export interface Shipped {
  version: string | null;
  at: string | null;
}

const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);

/** The act a release mode leaves to a person: the viewer's where they hold it, else its holders by name, else nobody and where it is granted. */
function personLeg(
  r: ReleaseFacts,
  mode: Exclude<ReleaseMode, 'automatic'>,
  said: { act: Said; reason: Said; version: string | null },
): ReleaseLeg {
  const holders = [...(r.holders ?? [])];
  const nobody = holders.length === 0 && !r.viewerOwes;
  const says = {
    who: r.viewerOwes ? say('standing.who.you') : holdersWho(holders.map((h) => h.name)),
    act: nobody ? nobodyHoldsAct(said.act, RELEASE_ACT_PERMISSION[mode]) : said.act,
    reason: said.reason,
  };
  return {
    kind: 'person',
    mode,
    who: sayEn(says.who),
    act: sayEn(says.act),
    reason: sayEn(says.reason),
    says,
    version: said.version,
    holders,
  };
}

/** The act the project's master owes here, by the one rule: agent work, with no person named. */
function masterLeg(
  mode: Exclude<ReleaseMode, 'automatic'>,
  said: { act: Said; reason: Said; version: string | null },
): ReleaseLeg {
  const says = { who: say('standing.who.projectMaster'), act: said.act, reason: said.reason };
  return {
    kind: 'master',
    mode,
    who: sayEn(says.who),
    act: sayEn(says.act),
    reason: sayEn(says.reason),
    says,
    version: said.version,
    holders: [],
  };
}

/** Whether the one rule gives the master this act; read as a person's where no rule was read. */
const mastersAct = (r: ReleaseFacts, kind: OwedActKind): boolean => r.owes?.(kind).by === 'master';

const cutAct = (v: string | null) =>
  v ? say('standing.act.cut', { v, more: null }) : say('forecast.act.cutNext');

export function releaseLegOf(r: ReleaseFacts): ReleaseLeg {
  const floor = r.floor ?? FORECAST_HISTORY_FLOOR;
  const v = r.nextVersion;
  switch (r.mode) {
    case 'automatic': {
      if (r.lags.length < floor) return { kind: 'not_enough_history', n: r.lags.length, floor };
      const sorted = ascending(r.lags);
      return {
        kind: 'automatic',
        basis: {
          n: sorted.length,
          floor,
          windowDays: FORECAST_WINDOW_DAYS,
          lagP50Minutes: Math.round(percentile(sorted, 0.5)),
          lagP85Minutes: Math.round(percentile(sorted, 0.85)),
        },
      };
    }
    case 'approval': {
      const names = (r.holders ?? []).map((h) => h.name).join(', ');
      const holders = names ? say('runs.rule.paren', { text: names }) : null;
      // ISS-1058: the cut is routine and the master's; the approval is a person's only where the
      // one rule says so (strict, approval required, or what the release carries cannot be undone)
      if (mastersAct(r, 'release.cut')) {
        if (mastersAct(r, 'release.cutAndApprove')) {
          return masterLeg('approval', {
            act: v
              ? say('standing.act.cutThenApprove', { v })
              : say('forecast.act.cutNextThenApprove'),
            reason: say('forecast.reason.masterCuts'),
            version: r.nextVersion,
          });
        }
        return masterLeg('approval', {
          act: cutAct(v),
          reason: say('forecast.reason.masterCutsPersonApproves', { holders }),
          version: r.nextVersion,
        });
      }
      return personLeg(r, 'approval', {
        act: v ? say('standing.act.cutThenApprove', { v }) : say('forecast.act.cutNextThenApprove'),
        reason: say('forecast.reason.approval', { holders }),
        version: r.nextVersion,
      });
    }
    case 'manual':
      if (mastersAct(r, 'release.cut')) {
        return masterLeg('manual', {
          act: cutAct(v),
          reason: say('forecast.reason.masterCuts'),
          version: r.nextVersion,
        });
      }
      return personLeg(r, 'manual', {
        act: cutAct(v),
        reason: say('forecast.reason.manual'),
        version: r.nextVersion,
      });
    case 'none':
      if (mastersAct(r, 'release.record')) {
        return masterLeg('none', {
          act: say('standing.act.recordLanding'),
          reason: say('forecast.reason.masterRecords'),
          version: null,
        });
      }
      return personLeg(r, 'none', {
        act: say('standing.act.releaseItByHand'),
        reason: say('forecast.reason.noProduction'),
        version: null,
      });
  }
}

function spanOf(now: Date, minutes: Float64Array): ForecastSpan {
  const sorted = Float64Array.from(minutes).sort();
  const p50 = Math.round(percentile(sorted, 0.5));
  const p85 = Math.round(percentile(sorted, 0.85));
  return {
    p50Minutes: p50,
    p85Minutes: p85,
    p50At: new Date(now.getTime() + p50 * MINUTE).toISOString(),
    p85At: new Date(now.getTime() + p85 * MINUTE).toISOString(),
  };
}

/**
 * The release lag still ahead of a change `age` minutes past its landing: drawn from the releases
 * that took at least that long, as an issue in flight is drawn from the landings that ran longer; one
 * older than every release on record has no such history and is drawn as a fresh lag.
 */
function lagDraw(lags: readonly number[], random: () => number) {
  return (age: number): number => {
    const longer = age > 0 ? lags.filter((m) => m > age) : lags;
    const pool = longer.length > 0 ? longer : lags;
    const drawn = pool[Math.floor(random() * pool.length)] as number;
    return longer.length > 0 ? drawn - age : drawn;
  };
}

interface DeliveryInput {
  asOf: string;
  now: Date;
  landing: Forecast;
  /** Each trial's landing in minutes from now, where `landing` is a range. */
  trials: Float64Array | null;
  /** The last landing, where `landing` is landed and something is still unshipped. */
  landedAt: Date | null;
  shipped: Shipped | null;
  release: ReleaseFacts;
  seed: number;
}

export function deliveryOf(i: DeliveryInput): DeliveryForecast {
  const stamp = { label: FORECAST_LABEL, asOf: i.asOf };
  const none = { ...stamp, landing: i.landing, release: null, inHands: null };
  if (i.shipped) return { ...none, shipped: i.shipped };
  if (i.landing.kind !== 'forecast' && i.landing.kind !== 'landed')
    return { ...none, shipped: null };
  const leg = releaseLegOf(i.release);
  if (leg.kind !== 'automatic') return { ...none, release: leg, shipped: null };
  const draw = lagDraw(i.release.lags, seeded(i.seed));
  let inHands: ForecastSpan | null = null;
  if (i.landing.kind === 'forecast' && i.trials) {
    const at = i.trials.map((landsIn) => landsIn + draw(0));
    inHands = spanOf(i.now, at);
  } else if (i.landing.kind === 'landed') {
    const age = i.landedAt ? Math.max(0, (i.now.getTime() - i.landedAt.getTime()) / MINUTE) : 0;
    inHands = spanOf(
      i.now,
      Float64Array.from({ length: FORECAST_TRIALS }, () => draw(age)),
    );
  }
  return { ...stamp, landing: i.landing, release: leg, inHands, shipped: null };
}
