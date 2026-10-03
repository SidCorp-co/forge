import {
  CHANGE_REQUEST_NUMBER_PATTERN,
  CONTRACT_REF_PATTERN,
  CONTRACT_WAIT_LIMITS,
} from '@forge/contracts/contract-waits';
import { z } from 'zod';
import { listContractRequests } from '../../ecosystem/requests/read.js';
import { issueContractWaitsOf } from '../../ecosystem/waits/read.js';
import {
  addContractWait,
  retractContractWait,
  type WaitOutcome,
} from '../../ecosystem/waits/service.js';
import { resolveIssueRouteRef } from '../../issues/issue-route-ref.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { type McpContext, refusedAnswer } from './lib.js';

export const WAIT_READS = ['contract_waits', 'contract_requests'] as const;
export const WAIT_WRITES = ['contract_wait_add', 'contract_wait_retract'] as const;
type WaitAction = (typeof WAIT_READS)[number] | (typeof WAIT_WRITES)[number];

const issue = z.string().trim().min(1).max(200);

export const WAIT_BY_ACTION = {
  contract_waits: z.strictObject({ issue }),
  contract_requests: z.strictObject({}),
  contract_wait_add: z.strictObject({
    issue,
    contract: z
      .string()
      .trim()
      .regex(CONTRACT_REF_PATTERN, 'contract is <provider slug>/<publication slug>'),
    minVersion: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.version),
    reason: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.reason).optional(),
    request: z.string().trim().regex(CHANGE_REQUEST_NUMBER_PATTERN).optional(),
  }),
  contract_wait_retract: z.strictObject({
    issue,
    wait: z.uuid(),
    reason: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.reason),
  }),
} satisfies Record<WaitAction, z.ZodType>;

export const WAIT_SHAPES: Record<WaitAction, string> = {
  contract_waits: '{ issue: ISS-n or the issue uuid }',
  contract_requests: '{}',
  contract_wait_add:
    '{ issue, contract: <provider slug>/<publication slug>, minVersion, reason?, request?: the change request number it rides on }',
  contract_wait_retract: '{ issue, wait: the wait uuid, reason }',
};

type Answer = Record<string, unknown>;

const refusedWith = (outcome: Extract<WaitOutcome, { ok: false }>) =>
  refusedAnswer(outcome.refusals, 'ECOSYSTEM_REFUSED');

async function issueIn(ctx: McpContext, side: string, ref: string) {
  const found = await resolveIssueRouteRef(ref, side, ctx.principal.userId);
  if (found.projectId !== side) {
    return refusedAnswer(
      [
        {
          code: 'ECOSYSTEM_RECORD_NOT_FOUND',
          path: '/issue',
          detail: `${ref} is an issue of another project; a wait is held by an issue of the project this call acts for.`,
        },
      ],
      'ECOSYSTEM_REFUSED',
    );
  }
  return found;
}

const actorOf = (ctx: McpContext) => ({
  userId: ctx.principal.userId,
  agency: ctx.principal.agency,
});

export const WAIT_HANDLERS: Record<
  WaitAction,
  (ctx: McpContext, side: string, a: Record<string, unknown>) => Promise<Answer>
> = {
  contract_waits: async (ctx, side, a) => {
    const found = await issueIn(ctx, side, String(a.issue));
    if (!('id' in found)) return found;
    return { ...(await issueContractWaitsOf(found.id, side)) };
  },
  contract_requests: async (ctx, side) => {
    await assertProjectAccess(side, ctx.principal.userId, 'viewer');
    return { requests: await listContractRequests(side) };
  },
  contract_wait_add: async (ctx, side, a) => {
    const found = await issueIn(ctx, side, String(a.issue));
    if (!('id' in found)) return found;
    const out = await addContractWait({
      issueId: found.id,
      projectId: side,
      actor: actorOf(ctx),
      request: {
        contract: String(a.contract),
        minVersion: String(a.minVersion),
        ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
        ...(typeof a.request === 'string' ? { request: a.request } : {}),
      },
    });
    return out.ok ? { wait: out.wait, created: out.created } : refusedWith(out);
  },
  contract_wait_retract: async (ctx, side, a) => {
    const found = await issueIn(ctx, side, String(a.issue));
    if (!('id' in found)) return found;
    const out = await retractContractWait({
      issueId: found.id,
      projectId: side,
      waitId: String(a.wait),
      actor: actorOf(ctx),
      reason: String(a.reason),
    });
    if (!out) {
      return refusedAnswer(
        [
          {
            code: 'ECOSYSTEM_RECORD_NOT_FOUND',
            path: '/wait',
            detail: `${String(a.issue)} holds no contract wait ${String(a.wait)}`,
          },
        ],
        'ECOSYSTEM_REFUSED',
      );
    }
    return out.ok ? { wait: out.wait } : refusedWith(out);
  },
};

export const WAIT_DESCRIPTION =
  "contract_waits ({ issue }, GET /api/issues/:id/contract-waits) reads what an issue waits on: another project's contract at or above a version, settled once the provider approves one, and whether that holds it out of dispatch (CONTRACT_WAIT_UNSETTLED at the run and claim doors). contract_wait_add ({ issue, contract: <provider>/<slug>, minVersion, reason?, request? }) adds one, by a member or the project's own agent; refused by name: CONTRACT_WAIT_CONTRACT_UNKNOWN, CONTRACT_WAIT_OWN_CONTRACT (use a blocks edge), CONTRACT_WAIT_NOT_SHARED, CONTRACT_WAIT_VERSION_NOT_IN_SCHEME, CONTRACT_WAIT_DUPLICATE, CONTRACT_WAIT_REQUEST_MISMATCH, CONTRACT_WAIT_WRITE_FORBIDDEN. contract_wait_retract ({ issue, wait, reason }) stops one (CONTRACT_WAIT_RETRACTED). A production release of the project is refused CONTRACT_PROVIDER_NOT_LIVE while a provider does not serve the version an issue in it waits on. contract_requests ({}) lists the change requests this project sent or received, each as the provider's draft requirement it landed as; a published change-request document is what files one (forge_channel).";

const prop = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  ...schema,
  description,
});

export const WAIT_PROPERTIES = {
  issue: prop('contract_waits, contract_wait_add, contract_wait_retract: ISS-n or the issue uuid.'),
  wait: prop('contract_wait_retract: the wait uuid.'),
  minVersion: prop("contract_wait_add: the version the issue needs, in the provider's scheme."),
  request: prop('contract_wait_add: the change request number the wait rides on, e.g. HOP-CR-3.'),
};
