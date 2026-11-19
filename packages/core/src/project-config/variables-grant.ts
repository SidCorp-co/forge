// A variable's value given through a one-time write URL a room agent asked for (ISS-1348): the person
// holding the value PUTs it where it lives, and it is judged as a direct write of that one key at that
// one scope (REQ-80 BC-2). It names no account, so the audit row says how it came (`via`, the ask and
// where the request came from) with the value's fingerprint, never the value. A variable not held yet
// is created a secret, protected where its environment is production-tier (BC-2), so a production
// value an agent asked for reaches production alone.

import { db } from '../db/client.js';
import { writeRefusals } from './variables-rules.js';
import {
  declaredEnvironments,
  requireVault,
  setIn,
  throwAll,
  type Writer,
} from './variables-service.js';
import { variableAt } from './variables-store.js';

const GRANT: Writer = { userId: null, agency: 'human', tokenId: null };

/** What a held variable, or a new one, is written as; its key and scope are the slot's. */
export async function writeVariableByGrant(input: {
  projectId: string;
  key: string;
  environment: string | null;
  value: string;
  detail: Record<string, unknown>;
}): Promise<{ fingerprint: string; created: boolean }> {
  requireVault();
  const environments = await declaredEnvironments(input.projectId);
  const tier = environments.find((e) => e.name === input.environment)?.tier;
  return db.transaction(async (tx) => {
    const held = await variableAt(tx, input.projectId, input.key, input.environment);
    const written = {
      key: input.key,
      environment: input.environment,
      type: held?.type ?? 'secret',
      protected: held?.protected ?? tier === 'production',
      value: input.value,
    };
    throwAll(writeRefusals(written, environments));
    const row = await setIn(tx, input.projectId, GRANT, written, {
      create: 'created',
      update: 'updated',
      detail: { ...input.detail, via: 'presigned' },
    });
    return { fingerprint: row.fingerprint, created: held === null };
  });
}

/** Whether the project holds a variable at this key and scope (no value is read). */
export async function variableHeld(
  projectId: string,
  key: string,
  environment: string | null,
): Promise<boolean> {
  return (await db.transaction((tx) => variableAt(tx, projectId, key, environment))) !== null;
}
