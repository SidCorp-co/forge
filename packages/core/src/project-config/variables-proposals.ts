// Changes agents propose to a project's environment variables (REQ-80 BC-6): held against the issue
// that needs them, the proposed value in the one store and shown only by fingerprint, taking effect
// only when a person holding env.manage approves, and judged again then as a direct write.

import { randomUUID } from 'node:crypto';
import type {
  DecideVariableProposalRequest,
  ProposeVariableRequest,
  VariableProposalView,
  VariableType,
} from '@forge/contracts/variables';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { encryptSecret, fingerprintSecret } from '../integrations/index.js';
import { requireHeld } from '../permissions/index.js';
import { type DeclaredEnvironment, writeRefusals } from './variables-rules.js';
import {
  type Caller,
  callerOf,
  declaredEnvironments,
  decrypted,
  eventOf,
  refuse,
  requireVault,
  requireWriter,
  setIn,
  throwAll,
} from './variables-service.js';
import {
  closeProposal,
  deleteVariable,
  dropValue,
  insertEvents,
  insertProposal,
  listProposals,
  type ProposalRow,
  proposalById,
  putValue,
  valueNameOf,
  valuesOf,
  variableAt,
} from './variables-store.js';

function proposalView(p: ProposalRow): VariableProposalView {
  return {
    id: p.id,
    issueId: p.issueId,
    act: p.act,
    key: p.key,
    environment: p.environment,
    type: p.type,
    protected: p.protected,
    fingerprint: p.fingerprint,
    status: p.status,
    reason: p.reason,
    proposedBy: p.proposedBy,
    decidedBy: p.decidedBy,
    decisionReason: p.decisionReason,
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
  };
}

/** The issue a proposal names on this project, by uuid or by its key (`ISS-12`). */
async function issueOf(projectId: string, ref: string): Promise<string> {
  const seq = /^[A-Za-z][A-Za-z0-9]*-([1-9][0-9]*)$/.exec(ref)?.[1];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const [row] =
    seq || uuid
      ? await db
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.projectId, projectId),
              seq ? eq(issues.issSeq, Number(seq)) : eq(issues.id, ref),
            ),
          )
          .limit(1)
      : [];
  if (!row) {
    throw refuse(
      'VARIABLE_PROPOSAL_ISSUE_UNKNOWN',
      `this project holds no issue ${ref}; a proposal names the issue that needs the change, by its key or uuid.`,
      '/issue',
    );
  }
  return row.id;
}

/** `POST /api/projects/:id/variables/proposals`: a change an issue needs, held until decided (BC-6). */
export async function proposeVariable(
  projectId: string,
  userId: string,
  req: ProposeVariableRequest,
) {
  const caller = await callerOf(projectId, userId);
  requireHeld(caller.access, 'project.write', 'proposing a variable change');
  if (req.act === 'set' && (req.value === undefined || req.type === undefined)) {
    throw refuse(
      'VARIABLE_PROPOSAL_SHAPE',
      'a proposal to set a variable carries its value and its type.',
      '/value',
    );
  }
  if (req.act === 'delete' && req.value !== undefined) {
    throw refuse(
      'VARIABLE_PROPOSAL_SHAPE',
      'a proposal to delete a variable carries no value.',
      '/value',
    );
  }
  if (req.value !== undefined) requireVault();
  const issueId = await issueOf(projectId, req.issue);
  if (req.act === 'set') {
    throwAll(
      writeRefusals(
        {
          key: req.key,
          environment: req.environment,
          type: req.type as VariableType,
          protected: req.protected ?? false,
          value: req.value,
        },
        await declaredEnvironments(projectId),
      ),
    );
  }
  const row = await db.transaction(async (tx) => {
    if (req.act === 'delete' && !(await variableAt(tx, projectId, req.key, req.environment))) {
      throw refuse(
        'VARIABLE_NOT_FOUND',
        `this project holds no ${req.key} scoped to ${req.environment ?? 'every environment'}, so there is nothing to delete.`,
        '/key',
      );
    }
    const id = randomUUID();
    const secretName = req.value === undefined ? null : valueNameOf('p', id);
    if (secretName && req.value !== undefined) {
      await putValue(tx, projectId, secretName, encryptSecret(req.value));
    }
    const fingerprint = req.value === undefined ? null : fingerprintSecret(projectId, req.value);
    const proposal = await insertProposal(tx, {
      id,
      projectId,
      issueId,
      act: req.act,
      key: req.key,
      environment: req.environment,
      type: req.act === 'set' ? (req.type ?? null) : null,
      protected: req.act === 'set' ? (req.protected ?? false) : null,
      secretName,
      fingerprint,
      reason: req.reason,
      proposedBy: userId,
    });
    await insertEvents(tx, [
      eventOf(caller, proposal, 'proposed', {
        newFingerprint: fingerprint,
        detail: { proposal: id, issue: issueId, proposedAct: req.act },
      }),
    ]);
    return proposal;
  });
  return proposalView(row);
}

export async function readVariableProposals(projectId: string, userId: string) {
  const caller = await callerOf(projectId, userId);
  requireHeld(caller.access, 'project.read', 'reading variable proposals');
  return { proposals: (await listProposals(projectId)).map(proposalView) };
}

/** `POST /api/projects/:id/variables/proposals/:proposal/decision` (BC-6). */
export async function decideVariableProposal(
  projectId: string,
  userId: string,
  id: string,
  req: DecideVariableProposalRequest,
) {
  const caller = await callerOf(projectId, userId);
  requireWriter(caller, 'deciding a variable proposal');
  const environments = await declaredEnvironments(projectId);
  const row = await db.transaction(async (tx) => {
    const proposal = await proposalById(tx, projectId, id);
    if (!proposal)
      throw refuse('VARIABLE_PROPOSAL_NOT_FOUND', `this project holds no variable proposal ${id}.`);
    if (proposal.status !== 'proposed') {
      throw refuse(
        'VARIABLE_PROPOSAL_DECIDED',
        `proposal ${id} was already ${proposal.status}${proposal.decisionReason ? `: ${proposal.decisionReason}` : ''}.`,
      );
    }
    const detail = {
      proposal: id,
      issue: proposal.issueId,
      proposedBy: proposal.proposedBy,
      reason: req.reason,
    };
    if (req.decision === 'approve')
      await approveIn(tx, projectId, caller, proposal, environments, detail);
    else {
      await insertEvents(tx, [
        eventOf(caller, proposal, 'rejected', { newFingerprint: proposal.fingerprint, detail }),
      ]);
    }
    if (proposal.secretName) await dropValue(tx, projectId, proposal.secretName);
    return closeProposal(tx, id, {
      status: req.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: userId,
      reason: req.reason,
    });
  });
  return proposalView(row);
}

async function approveIn(
  tx: Tx,
  projectId: string,
  caller: Caller,
  proposal: ProposalRow,
  environments: readonly DeclaredEnvironment[],
  detail: Record<string, unknown>,
): Promise<void> {
  if (proposal.act === 'delete') {
    const held = await variableAt(tx, projectId, proposal.key, proposal.environment);
    if (!held) {
      throw refuse(
        'VARIABLE_NOT_FOUND',
        `${proposal.key} is no longer held at that scope; reject the proposal.`,
      );
    }
    await deleteVariable(tx, held);
    await insertEvents(tx, [
      eventOf(caller, held, 'approved', {
        variableId: held.id,
        oldFingerprint: held.fingerprint,
        detail: { ...detail, proposedAct: 'delete' },
      }),
    ]);
    return;
  }
  requireVault();
  const enc = proposal.secretName
    ? (await valuesOf(projectId, [proposal.secretName], tx)).get(proposal.secretName)
    : undefined;
  const value = decrypted(proposal, enc);
  const input = {
    key: proposal.key,
    environment: proposal.environment,
    type: proposal.type ?? 'plain',
    protected: proposal.protected ?? false,
    value,
  };
  // the project document may have changed since the proposal: it is judged again as a direct write
  throwAll(writeRefusals(input, environments));
  await setIn(tx, projectId, caller, input, {
    create: 'approved',
    update: 'approved',
    detail: { ...detail, proposedAct: 'set' },
  });
}
