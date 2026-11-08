// One simulation of a project's open work per read request and clock (ISS-1070): a person's home asks
// it of each project from every feedback line's scope and again for the project's own dates, and a
// simulation reads the project's whole open standing. Held for the request only (`db/read-memo.ts`).

import type { ProjectForecast } from '@forge/contracts/forecast';
import type { IssueStandingRow } from '@forge/contracts/issue-standing';
import { heldRead, offerRead } from '../db/read-memo.js';
import { issueWaitsOf } from '../issues/index.js';
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

/**
 * Each of `ids`' standing wait as the project's simulation read it with every open issue, so a reader
 * of a few of them beside the forecast sends no standing of its own (ISS-1070 r18: the home's Moving
 * read its owned issues' standing again, a wave behind); an id it did not read is read on its own.
 */
export async function simulatedWaitsOf(
  projectId: string,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, Pick<IssueStandingRow, 'key' | 'standing'>>> {
  const f = await simulated(projectId, now);
  const out = new Map<string, Pick<IssueStandingRow, 'key' | 'standing'>>();
  const missing: string[] = [];
  for (const id of ids) {
    const held = f.waits.get(id);
    if (held) out.set(id, held);
    else missing.push(id);
  }
  for (const [id, w] of await issueWaitsOf(projectId, missing, now)) out.set(id, w);
  return out;
}
