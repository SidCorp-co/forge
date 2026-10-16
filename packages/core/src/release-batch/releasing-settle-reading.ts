// What the releasing sweep reads of production before it settles a row (ISS-1421): the commit the
// project's verified live deployment serves, and whether that commit carries the row's landing
// commit. Only a verified identity that DESCENDS from the landing commit closes an issue; every
// other reading returns it to the gate, and says why.

import { withRepository } from '../projects/repository-access.js';
import { type RepositoryReader, saying } from '../projects/repository-reader.js';
import { carriageOf } from './carriage.js';
import { readServingDeployment } from './serving.js';
import { claimedCommit } from './verify.js';

export type ProductionFinding =
  | { kind: 'carried'; serving: string; servingWhole: string; landing: string }
  | { kind: 'not-carried'; serving: string; landing: string }
  | { kind: 'unverified' }
  | { kind: 'no-landing' }
  | { kind: 'unread'; why: string };

/** A project's production, read once; each landing is then asked of it. */
export interface ProductionReading {
  forLanding(landing: string): Promise<ProductionFinding>;
}

type Served =
  | { kind: 'identity'; identity: string }
  | Extract<ProductionFinding, { kind: 'unverified' | 'unread' }>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A live deployment that is not up, as the sweep's comment says it. */
const NOT_UP = {
  down: 'the probe of the live deployment reports it down',
  unknown: 'no probe of the live deployment has answered yet',
} as const;

async function servedIdentity(projectId: string): Promise<Served> {
  let read: Awaited<ReturnType<typeof readServingDeployment>>;
  try {
    read = await readServingDeployment(projectId);
  } catch (err) {
    return { kind: 'unread', why: message(err) };
  }
  if (!read.ok) {
    return {
      kind: 'unread',
      why: read.code === 'NO_PROJECT' ? 'the project was not found' : read.detail,
    };
  }
  const live = read.deployment;
  if (!live.verified) return { kind: 'unverified' };
  if (live.disagreement) {
    return {
      kind: 'unread',
      why: `the live probes disagree on what is serving (${live.disagreement.join(', ')})`,
    };
  }
  if (live.health !== 'up') {
    return { kind: 'unread', why: NOT_UP[live.health] };
  }
  if (!live.identity) {
    return { kind: 'unread', why: 'the live probes answered and none named a commit' };
  }
  return { kind: 'identity', identity: live.identity };
}

async function wholeSha(reader: RepositoryReader, identity: string): Promise<string | null> {
  const whole = claimedCommit(identity);
  if (whole) return whole;
  const found = await reader.commit(identity);
  return found.kind === 'found' ? found.sha.toLowerCase() : null;
}

async function carriedAt(
  projectId: string,
  landing: string,
  serving: string,
): Promise<ProductionFinding> {
  try {
    return await withRepository(projectId, async (access): Promise<ProductionFinding> => {
      if (access.kind === 'refused') {
        return { kind: 'unread', why: `the repository could not be read: ${saying(access)}` };
      }
      const carriage = await carriageOf(access.reader, landing, serving);
      if (carriage.kind === 'unread') {
        return {
          kind: 'unread',
          why: `whether ${serving} carries ${landing} could not be read: ${carriage.why}`,
        };
      }
      if (carriage.kind === 'differs') return { kind: 'not-carried', serving, landing };
      const servingWhole = await wholeSha(access.reader, serving);
      if (!servingWhole) {
        return {
          kind: 'unread',
          why: `the serving commit ${serving} could not be named by its whole sha`,
        };
      }
      return { kind: 'carried', serving, servingWhole, landing };
    });
  } catch (err) {
    return { kind: 'unread', why: message(err) };
  }
}

export async function readProductionFinding(projectId: string): Promise<ProductionReading> {
  const served = await servedIdentity(projectId);
  return {
    forLanding: async (landing) =>
      served.kind === 'identity' ? carriedAt(projectId, landing, served.identity) : served,
  };
}
