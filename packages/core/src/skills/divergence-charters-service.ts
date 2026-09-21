import { db } from '../db/client.js';
import {
  getCharterByProject,
  type UpsertCharterInput,
  upsertCharter,
} from './divergence-charters.js';

/** The charter for `projectId`, or `null`. */
export async function readCharter(
  projectId: string,
): Promise<Awaited<ReturnType<typeof getCharterByProject>>> {
  return getCharterByProject(db, projectId);
}

export async function upsertCharterAtomic(
  input: UpsertCharterInput,
): Promise<Awaited<ReturnType<typeof upsertCharter>>> {
  return db.transaction(async (tx) => upsertCharter(tx, input));
}
