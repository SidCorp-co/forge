// A project's environment variables (REQ-80, design `environment-variables` r3): listed with
// secrets masked (BC-1), changed only by a holder of env.manage and audited by fingerprint (BC-2),
// proposed by agents and decided by a holder (BC-6). Values go into the one secret store and leave it
// only on an explicit reveal by a person, or at the run door (`variables-run-door.ts`).

import { randomUUID } from 'node:crypto';
import {
  type CreateVariableRequest,
  ENV_MANAGE,
  MASKED_VARIABLE_TYPES,
  type UpdateVariableRequest,
  type VariableEventView,
  type VariableRefusalCode,
  type VariableType,
  type VariableView,
} from '@forge/contracts/variables';
import { db, type Tx } from '../db/client.js';
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  isVaultConfigured,
} from '../integrations/index.js';
import { loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import { actorFor, holds, requireHeld } from '../permissions/index.js';
import { environmentsOf } from './release-path.js';
import { readProjectConfig } from './service.js';
import { type DeclaredEnvironment, writeRefusals } from './variables-rules.js';
import {
  deleteVariable,
  type EventInput,
  insertEvents,
  insertVariable,
  listEvents,
  listProposals,
  listVariables,
  putValue,
  updateVariable,
  type VariableRow,
  valueNameOf,
  valuesOf,
  variableAt,
  variableById,
} from './variables-store.js';

export const refuse = refuser<VariableRefusalCode>('VARIABLE_REFUSED');

/** Where an agent reads a value: inside a run, never at a project route (BC-6). */
const RUN_DOOR = 'GET /api/jobs/<run id>/variables/<environment>';

export interface Caller {
  userId: string;
  access: ProjectAccess;
  agency: 'human' | 'agent';
  tokenId: string | null;
}

export async function callerOf(projectId: string, userId: string): Promise<Caller> {
  const access = await loadProjectAccess(projectId, userId);
  const actor = actorFor(userId);
  return {
    userId,
    access,
    agency: actor.agency === 'agent' ? 'agent' : 'human',
    tokenId: actor.tokenId,
  };
}

/** A person holding env.manage may write directly; an agent credential proposes instead (BC-6). */
export function requireWriter(caller: Caller, act: string): void {
  requireHeld(caller.access, ENV_MANAGE, act);
  if (caller.agency === 'agent') {
    throw refuse(
      'VARIABLE_AGENT_PROPOSES',
      `${act} is a person's act: an agent credential writes no variable directly, whatever it holds. Propose the change on the issue that needs it with POST /api/projects/${caller.access.projectId}/variables/proposals; it takes effect when a holder of ${ENV_MANAGE} approves it.`,
    );
  }
}

export function requireVault(): void {
  if (!isVaultConfigured()) {
    throw refuse(
      'VARIABLE_VAULT_NOT_CONFIGURED',
      'INTEGRATION_MASTER_KEY is not set on this core, so no variable value can be encrypted or read; nothing was written.',
    );
  }
}

export function throwAll(
  refusals: readonly { code: string; path: string; detail: string }[],
): void {
  if (refusals.length > 0) throw new RefusalError(refusals, 'VARIABLE_REFUSED');
}

/** The environments the project document declares, by name and tier. */
export async function declaredEnvironments(projectId: string): Promise<DeclaredEnvironment[]> {
  const held = await readProjectConfig(projectId);
  if (!held) return [];
  return environmentsOf(held.document).map((e) => ({ name: e.name, tier: e.declaration.tier }));
}

export const eventOf = (
  caller: Caller,
  row: { projectId: string; key: string; environment: string | null },
  act: EventInput['act'],
  more: Partial<EventInput> = {},
): EventInput => ({
  projectId: row.projectId,
  variableId: null,
  act,
  key: row.key,
  environment: row.environment,
  actorId: caller.userId,
  actorTokenId: caller.tokenId,
  agency: caller.agency,
  ...more,
});

export function decrypted(row: { key: string }, enc: Buffer | undefined): string {
  if (!enc) {
    throw refuse(
      'VARIABLE_VALUE_UNREADABLE',
      `${row.key} names a value the store does not hold; write the variable again.`,
    );
  }
  try {
    return decryptSecret(enc);
  } catch (err) {
    throw refuse(
      'VARIABLE_VALUE_UNREADABLE',
      `${row.key} is stored but does not decrypt under this core's INTEGRATION_MASTER_KEY (${err instanceof Error ? err.message : String(err)}); write it again.`,
    );
  }
}

async function heldValue(row: VariableRow, tx: Tx = db): Promise<string> {
  const values = await valuesOf(row.projectId, [row.secretName], tx);
  return decrypted(row, values.get(row.secretName));
}

function view(row: VariableRow, value: string | null): VariableView {
  return {
    id: row.id,
    key: row.key,
    environment: row.environment,
    type: row.type,
    protected: row.protected,
    fingerprint: row.fingerprint,
    version: row.version,
    value,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/** Every variable of the project: names to any reader, plain values to a person holding env.manage (BC-1, BC-6). */
export async function readVariables(projectId: string, userId: string) {
  const caller = await callerOf(projectId, userId);
  requireHeld(caller.access, 'project.read', 'reading the project’s variables');
  const rows = await listVariables(projectId);
  const seesPlain =
    caller.agency === 'human' && holds(caller.access, ENV_MANAGE) && isVaultConfigured();
  const shown = seesPlain ? rows.filter((r) => r.type === 'plain') : [];
  const values = await valuesOf(
    projectId,
    shown.map((r) => r.secretName),
  );
  const proposals = await listProposals(projectId);
  return {
    variables: rows.map((r) =>
      view(r, seesPlain && r.type === 'plain' ? decrypted(r, values.get(r.secretName)) : null),
    ),
    environments: await declaredEnvironments(projectId),
    canManage: holds(caller.access, ENV_MANAGE) && caller.agency === 'human',
    proposalsWaiting: proposals.filter((p) => p.status === 'proposed').length,
    says: `a secret or file value is never listed: a person holding ${ENV_MANAGE} reveals one with POST /api/projects/${projectId}/variables/<variable>/reveal, and a run reads the variables of the environment it targets at ${RUN_DOOR}. An agent proposes a change at POST /api/projects/${projectId}/variables/proposals.`,
  };
}

interface SetInput {
  key: string;
  environment: string | null;
  type: VariableType;
  protected: boolean;
  value: string;
}

/** Store a value at a key and scope, creating the variable or replacing the one held there. */
export async function setIn(
  tx: Tx,
  projectId: string,
  caller: Caller,
  input: SetInput,
  act: {
    create: 'created' | 'approved';
    update: 'updated' | 'approved';
    detail?: Record<string, unknown>;
  },
): Promise<VariableRow> {
  const fingerprint = fingerprintSecret(projectId, input.value);
  const held = await variableAt(tx, projectId, input.key, input.environment);
  if (held) {
    await putValue(tx, projectId, held.secretName, encryptSecret(input.value));
    const row = await updateVariable(tx, held.id, {
      type: input.type,
      protected: input.protected,
      fingerprint,
      version: held.version + 1,
      userId: caller.userId,
    });
    await insertEvents(tx, [
      eventOf(caller, row, act.update, {
        variableId: row.id,
        oldFingerprint: held.fingerprint,
        newFingerprint: fingerprint,
        detail: { ...act.detail, type: row.type, protected: row.protected },
      }),
    ]);
    return row;
  }
  const id = randomUUID();
  await putValue(tx, projectId, valueNameOf('v', id), encryptSecret(input.value));
  const row = await insertVariable(tx, {
    id,
    projectId,
    ...input,
    fingerprint,
    userId: caller.userId,
  });
  await insertEvents(tx, [
    eventOf(caller, row, act.create, {
      variableId: row.id,
      newFingerprint: fingerprint,
      detail: { ...act.detail, type: row.type, protected: row.protected },
    }),
  ]);
  return row;
}

/** `POST /api/projects/:id/variables` (BC-2). */
export async function createVariable(
  projectId: string,
  userId: string,
  req: CreateVariableRequest,
) {
  const caller = await callerOf(projectId, userId);
  requireWriter(caller, 'adding a variable');
  requireVault();
  throwAll(writeRefusals(req, await declaredEnvironments(projectId)));
  try {
    const row = await db.transaction(async (tx) => {
      if (await variableAt(tx, projectId, req.key, req.environment)) {
        throw refuse(
          'VARIABLE_EXISTS',
          `this project already holds ${req.key} scoped to ${req.environment === null ? 'every environment' : `environment \`${req.environment}\``}; change that one with PUT /api/projects/${projectId}/variables/<variable>.`,
          '/key',
        );
      }
      return setIn(tx, projectId, caller, req, { create: 'created', update: 'updated' });
    });
    return view(row, null);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw refuse(
        'VARIABLE_EXISTS',
        `${req.key} was added at that scope while this write ran; read the list again.`,
        '/key',
      );
    }
    throw err;
  }
}

async function heldOrRefuse(tx: Tx, projectId: string, id: string): Promise<VariableRow> {
  const row = await variableById(tx, projectId, id, true);
  if (!row) throw refuse('VARIABLE_NOT_FOUND', `this project holds no variable ${id}.`);
  return row;
}

function staleOrNot(row: VariableRow, baseVersion: number): void {
  if (row.version !== baseVersion) {
    throw refuse(
      'VARIABLE_STALE',
      `${row.key} is at version ${row.version}, not ${baseVersion}, which this change was read against; read it again.`,
      '/baseVersion',
    );
  }
}

/** `PUT /api/projects/:id/variables/:variable`: value, type or protection, against the version read (BC-2). */
export async function changeVariable(
  projectId: string,
  userId: string,
  id: string,
  req: UpdateVariableRequest,
) {
  const caller = await callerOf(projectId, userId);
  requireWriter(caller, 'changing a variable');
  requireVault();
  const environments = await declaredEnvironments(projectId);
  const row = await db.transaction(async (tx) => {
    const held = await heldOrRefuse(tx, projectId, id);
    staleOrNot(held, req.baseVersion);
    const type = req.type ?? held.type;
    const isProtected = req.protected ?? held.protected;
    const maskedNow =
      MASKED_VARIABLE_TYPES.includes(type) && !MASKED_VARIABLE_TYPES.includes(held.type);
    const judged = req.value ?? (maskedNow ? await heldValue(held, tx) : undefined);
    throwAll(
      writeRefusals(
        {
          key: held.key,
          environment: held.environment,
          type,
          protected: isProtected,
          value: judged,
        },
        environments,
      ),
    );
    const changed = [
      ...(req.value !== undefined ? ['value'] : []),
      ...(type !== held.type ? ['type'] : []),
      ...(isProtected !== held.protected ? ['protected'] : []),
    ];
    const fingerprint =
      req.value === undefined ? held.fingerprint : fingerprintSecret(projectId, req.value);
    if (req.value !== undefined)
      await putValue(tx, projectId, held.secretName, encryptSecret(req.value));
    const updated = await updateVariable(tx, held.id, {
      type,
      protected: isProtected,
      fingerprint,
      version: held.version + 1,
      userId,
    });
    await insertEvents(tx, [
      eventOf(caller, updated, 'updated', {
        variableId: updated.id,
        oldFingerprint: held.fingerprint,
        newFingerprint: fingerprint,
        detail: { changed, type, protected: isProtected },
      }),
    ]);
    return updated;
  });
  return view(row, null);
}

/** `DELETE /api/projects/:id/variables/:variable?baseVersion=n`: the variable and its value (BC-2). */
export async function removeVariable(
  projectId: string,
  userId: string,
  id: string,
  baseVersion: number,
) {
  const caller = await callerOf(projectId, userId);
  requireWriter(caller, 'deleting a variable');
  await db.transaction(async (tx) => {
    const held = await heldOrRefuse(tx, projectId, id);
    staleOrNot(held, baseVersion);
    await deleteVariable(tx, held);
    await insertEvents(tx, [
      eventOf(caller, held, 'deleted', { variableId: held.id, oldFingerprint: held.fingerprint }),
    ]);
  });
  return { deleted: id };
}

/** `POST /api/projects/:id/variables/:variable/reveal`: one value, to a person holding env.manage (BC-1). */
export async function revealVariable(projectId: string, userId: string, id: string) {
  const caller = await callerOf(projectId, userId);
  requireHeld(caller.access, ENV_MANAGE, 'revealing a variable');
  if (caller.agency === 'agent') {
    throw refuse(
      'VARIABLE_VALUE_AGENT_REFUSED',
      `an agent credential reads no variable value outside a run, whatever it holds: a run reads the variables of the environment it targets at ${RUN_DOOR}. Nothing was answered.`,
    );
  }
  requireVault();
  return db.transaction(async (tx) => {
    const held = await heldOrRefuse(tx, projectId, id);
    const value = await heldValue(held, tx);
    await insertEvents(tx, [
      eventOf(caller, held, 'revealed', { variableId: held.id, newFingerprint: held.fingerprint }),
    ]);
    return { id: held.id, key: held.key, environment: held.environment, value };
  });
}

/** `GET /api/projects/:id/variables/events`: the audit, newest first, with no value in it (BC-2). */
export async function readVariableEvents(
  projectId: string,
  userId: string,
): Promise<{ events: VariableEventView[] }> {
  const caller = await callerOf(projectId, userId);
  requireHeld(caller.access, 'project.read', 'reading the variables audit');
  const rows = await listEvents(projectId, 200);
  return {
    events: rows.map((e) => ({
      id: e.id,
      act: e.act,
      key: e.key,
      environment: e.environment,
      actor: e.actorId,
      agency: e.agency === 'human' || e.agency === 'agent' ? e.agency : null,
      oldFingerprint: e.oldFingerprint,
      newFingerprint: e.newFingerprint,
      detail: e.detail,
      at: e.at.toISOString(),
    })),
  };
}
