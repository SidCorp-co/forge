/**
 * The transaction-owning form of the charter read/write, for transports.
 *
 * `divergence-charters.ts` takes an executor and never imports the pool — that
 * is deliberate: importing the live `db` there would pull `config/env` into
 * every test that loads the module, and its own suite runs without a database
 * at all. So the transaction is opened here instead, and a route or tool needs
 * no database handle of its own to satisfy the same-transaction invariant.
 */

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

// cm:edge protocol -> packages/core/src/skills/divergence-charters.ts — that module's guard requires `upsertCharter` to run inside a transaction so `charter.changed` lands with the upsert (invariant §9.11); this wrapper is what supplies one, and calling `upsertCharter` directly from a transport would break the invariant silently
export async function upsertCharterAtomic(
  input: UpsertCharterInput,
): Promise<Awaited<ReturnType<typeof upsertCharter>>> {
  return db.transaction(async (tx) => upsertCharter(tx, input));
}
