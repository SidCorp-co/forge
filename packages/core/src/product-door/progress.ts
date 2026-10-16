// Whether work is running on something and when it is likely done, in the words a person reads, from
// the facts the forecast and the agent sessions already decided. Nothing here estimates: a date is the
// forecast's p50/p85 or there is none, and where there is none the answer says why (VISION:
// state-never-lies).

import {
  deliveryDatesOf,
  type Forecast,
  type ForecastPaused,
  type ScopeForecast,
} from '@forge/contracts/forecast';

/** What an agent session on an issue is doing, as `issues/agent-sessions-hydrator.ts` derives it. */
export type AgentState = 'running' | 'queued' | 'completed' | 'failed' | 'cancelled' | null;

export interface Progress {
  /** A coding agent is working on it right now. */
  running: boolean;
  /** The forecast's dates: likely by its p50, at the latest by its p85; null where it holds none. */
  eta: { likelyBy: string; latestBy: string; confidence: string } | null;
  /** The same, said: what is happening, and the date or why there is none. */
  says: string;
}

const day = (iso: string) => iso.slice(0, 10);

function runningSays(agent: AgentState): string | null {
  if (agent === 'running') return 'An agent is working on it now.';
  if (agent === 'queued') return 'Queued: an agent picks it up next.';
  return null;
}

function waitSays(p: Pick<ForecastPaused, 'who' | 'act' | 'reason'>): string {
  const act = p.act ? ` to ${p.act}` : '';
  const reason = p.reason ? ` (${p.reason})` : '';
  return `It waits on ${p.who}${act}${reason}.`;
}

function lateSays(f: Forecast): string | null {
  if ((f.kind !== 'forecast' && f.kind !== 'paused') || !f.late) return null;
  const hours = Math.round(f.late.byMinutes / 60);
  return f.late.reason === 'p85_passed'
    ? `It is late: past its latest date by about ${hours} h.`
    : `It is late: the wait is over a day old (${hours} h past).`;
}

/** One issue's progress: the agent's state on it and its forecast. */
export function issueProgress(forecast: Forecast | null, agent: AgentState): Progress {
  const running = agent === 'running';
  const now = runningSays(agent);
  const parts: (string | null)[] = [];
  let eta: Progress['eta'] = null;
  if (!forecast) {
    parts.push(now ?? 'Nothing is running on it.', 'No forecast was read for it.');
  } else if (forecast.kind === 'landed') {
    const at = forecast.landedAt ? ` on ${day(forecast.landedAt)}` : '';
    parts.push(`Done: it landed${at}. Nothing runs on it.`);
  } else if (forecast.kind === 'ended') {
    parts.push(`It ended as ${forecast.status} without landing. Nothing runs on it.`);
  } else if (forecast.kind === 'paused') {
    parts.push(now ?? 'Not running.', waitSays(forecast), 'No date while it waits.');
  } else if (forecast.kind === 'not_enough_history') {
    parts.push(
      now ?? 'Not running yet.',
      `No ETA: the forecast needs ${forecast.floor} landed issues to learn from and has ${forecast.n}.`,
    );
  } else {
    eta = {
      likelyBy: forecast.p50At,
      latestBy: forecast.p85At,
      confidence: forecast.confidence.level,
    };
    const ahead =
      forecast.ahead > 0
        ? `Not started: ${forecast.ahead} issue(s) go first (${forecast.aheadKeys.join(', ')}).`
        : 'Not running yet.';
    const blocked =
      forecast.waitsOn.length > 0 ? `It waits on ${forecast.waitsOn.join(', ')} first.` : null;
    parts.push(
      now ?? ahead,
      blocked,
      `Likely done by ${day(forecast.p50At)}, at the latest ${day(forecast.p85At)} (${forecast.confidence.level} confidence).`,
    );
  }
  parts.push(forecast ? lateSays(forecast) : null);
  return { running, eta, says: parts.filter(Boolean).join(' ') };
}

/** A set of issues delivered together (a draft release, a requirement): how far, and when in hands. */
export function scopeProgress(scope: ScopeForecast, runningKeys: readonly string[]): Progress {
  const { total, shipped, awaitingRelease, toDo } = scope.progress;
  const parts: (string | null)[] = [];
  if (total === 0) {
    return {
      running: false,
      eta: null,
      says: 'It holds no issue yet, so nothing runs and no date.',
    };
  }
  parts.push(
    `${toDo} of ${total} issue(s) still to land, ${awaitingRelease} landed and waiting for a release, ${shipped} shipped.`,
  );
  parts.push(
    runningKeys.length > 0
      ? `An agent is working now on ${runningKeys.join(', ')}.`
      : toDo > 0
        ? 'No agent is working on its issues right now.'
        : null,
  );
  const dates = deliveryDatesOf(scope.delivery);
  const landing = scope.forecast;
  if (dates) {
    parts.push(
      `${dates.of === 'hands' ? 'In people’s hands' : 'All landed'} likely by ${day(dates.p50At)}, at the latest ${day(dates.p85At)}.`,
    );
  } else if (landing?.kind === 'paused') {
    parts.push(waitSays(landing), 'No date while it waits.');
  } else if (landing?.kind === 'not_enough_history') {
    parts.push(
      `No ETA: the forecast needs ${landing.floor} landed issues to learn from and has ${landing.n}.`,
    );
  } else if (toDo > 0) {
    parts.push('No ETA: the forecast holds no date for it.');
  }
  if (scope.next) parts.push(`Then ${waitSays(scope.next).replace(/^It w/, 'it w')}`);
  if (landing) parts.push(lateSays(landing));
  return {
    running: runningKeys.length > 0,
    eta: dates
      ? {
          likelyBy: dates.p50At,
          latestBy: dates.p85At,
          confidence: landing?.kind === 'forecast' ? landing.confidence.level : 'unknown',
        }
      : null,
    says: parts.filter(Boolean).join(' '),
  };
}
