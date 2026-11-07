// One simulation of a project's open work per read request and clock (ISS-1070): a person's home asks
// it of each project from every feedback line's scope and again for the project's own dates, and a
// simulation reads the project's whole open standing. Held for the request only (`db/read-memo.ts`).

import type { ProjectForecast } from '@forge/contracts/forecast';
import { heldRead, offerRead } from '../db/read-memo.js';
import type { Anchor } from './facts.js';
import { type Facts, pausedOf, simulate, stamp } from './read.js';

/**
 * `simulate` once per project and clock in a read request. `anchored` is the anchor as of `now`,
 * which the simulation reads itself where none is handed it, so the answer is the same either way.
 * Held, never copied: no reader of a simulation changes it.
 */
export function simulated(projectId: string, now: Date, anchored?: Anchor): Promise<Facts> {
  const key = `forecast-simulation:${projectId}:${now.toISOString()}`;
  return heldRead<Facts>(key) ?? offerRead(key, () => simulate(projectId, now, anchored));
}

export async function readProjectForecast(
  projectId: string,
  now: Date = new Date(),
): Promise<ProjectForecast> {
  const f = await simulated(projectId, now);
  return {
    ...stamp(f.run.asOf),
    projectId,
    pause: f.projectWait ? pausedOf(f.run.asOf, f.projectWait) : null,
    issues: [...f.keyOf].flatMap(([issueId, key]) => {
      const forecast = f.run.forecasts.get(key);
      return forecast ? [{ issueId, key, forecast }] : [];
    }),
  };
}
