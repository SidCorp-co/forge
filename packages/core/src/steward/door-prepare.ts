// The steward prepares a stale draft before it asks anything about it (REQ-48 BC-5, the coordinator's
// ruling of 2026-10-22): nobody is asked to write a plan or criteria, the steward writes them. One call
// links the agreed requirement the draft delivers, saves a short plan, which records that requirement's
// current revision as the one it is planned against, and writes the issue's criteria, each traced to a
// BC of it, through the issue's own doors as the steward account. Each write that lands is its own act
// with its own undo, and the answer is the issue-ready check as the draft now stands.

import { z } from 'zod';
import { type DoorAnswer, type DoorRequest, doorName } from './door-call.js';
import { type ActOf, cite, type DoorContext, type DoorSpec, issueKey, send } from './door-kit.js';

/** A criterion reads as a checkable statement of the outcome, never an instruction to verify one. */
const INSTRUCTION = /^(verify|check|ensure|confirm|test|make sure|validate)\b/i;

const criterion = z.strictObject({
  statement: z
    .string()
    .trim()
    .min(10)
    .max(500)
    .refine((s) => !INSTRUCTION.test(s), {
      message:
        'a criterion is a checkable statement of what holds ("A reload shows every saved card"), never an instruction ("Verify the cards are saved")',
    }),
  bc: z
    .string()
    .trim()
    .regex(/^BC-\d+$/i, 'a BC of the requirement, as BC-n'),
});

const prepareParams = z.strictObject({
  issue: issueKey.describe('ISS-n: the draft to prepare'),
  requirement: z
    .string()
    .trim()
    .regex(/^REQ-\d+$/i, 'the agreed requirement it delivers, as REQ-n')
    .describe(
      "the agreed requirement it delivers: the carried feedback's triaged one, else the best fit",
    ),
  plan: z
    .string()
    .trim()
    .min(20)
    .max(2000)
    .describe(
      'what the issue delivers and why, in a few BA sentences; its driver writes the steps',
    ),
  criteria: z
    .array(criterion)
    .min(1)
    .max(10)
    .describe(
      "the issue's criteria, each a checkable statement from the feedback case and the BC text",
    ),
});

interface RequirementRead {
  id?: string;
  key?: string;
  status?: string;
  currentRevision?: number | null;
  criteria?: { id: string; code: string; body: string }[];
}

interface CriterionRead {
  n?: number;
  statement?: string;
  requirementCriterionId?: string | null;
}

const DELIVERABLE = ['agreed', 'accepted'];

const correct = (text: string) => ({ correct: text });

export const PREPARE: DoorSpec<z.infer<typeof prepareParams>> = {
  name: 'steward_prepare_draft',
  describe:
    "Prepare a draft so it can open: link the agreed requirement it delivers, save a short plan (which records that requirement's current revision), and write its criteria, each traced to a BC. Answers the issue-ready check as it then stands. Take the requirement from the carried feedback's triage, else the best agreed fit by area and title.",
  params: prepareParams,
  write: true,
  async call(args, ctx: DoorContext) {
    const read = await send(
      { method: 'GET', path: `/api/issues/${args.issue}?projectId=${ctx.projectId}` },
      ctx,
    );
    if (!read.answer.ok) return read;
    const issue = (read.answer.json ?? {}) as {
      id?: string;
      status?: string;
      plan?: string | null;
      requirementId?: string | null;
    };
    if (!issue.id) return read;
    if (issue.status !== 'draft') {
      return correct(`${args.issue} is ${issue.status}: only a draft is prepared.`);
    }
    const requirement = args.requirement.toUpperCase();
    const reqRead = await send(
      { method: 'GET', path: `/api/projects/${ctx.projectId}/requirements/${requirement}` },
      ctx,
    );
    if (!reqRead.answer.ok) return reqRead;
    const req = (reqRead.answer.json ?? {}) as RequirementRead;
    if (!DELIVERABLE.includes(req.status ?? '') || req.currentRevision == null) {
      return correct(
        `${requirement} is ${req.status ?? 'unknown'}: a draft delivers only an agreed or accepted requirement with a current revision. Where none fits, ask its decision with steward_decide (link, requirement or drop).`,
      );
    }
    const bcs = new Map((req.criteria ?? []).map((c) => [c.code.toUpperCase(), c]));
    const unknown = args.criteria.filter((c) => !bcs.has(c.bc.toUpperCase())).map((c) => c.bc);
    if (unknown.length > 0) {
      return correct(
        `${requirement} revision ${req.currentRevision} has no ${unknown.join(', ')}; its BCs are ${[...bcs.keys()].join(', ') || 'none'}.`,
      );
    }
    const before = await send({ method: 'GET', path: `/api/issues/${issue.id}/criteria` }, ctx);
    const priorCriteria = ((before.answer.json?.criteria ?? []) as CriterionRead[]).map((c) => ({
      ...(c.n ? { n: c.n } : {}),
      statement: c.statement ?? '',
      requirementCriterionId: c.requirementCriterionId ?? null,
    }));
    const landed: ActOf[] = [];
    const halt = (step: { request: DoorRequest; answer: DoorAnswer }) => ({
      ...step,
      acts: landed,
    });

    // a draft already delivering it keeps its link: only a link this call makes is its act
    if (!req.id || issue.requirementId !== req.id) {
      const link = await send(
        {
          method: 'POST',
          path: `/api/projects/${ctx.projectId}/requirements/${requirement}/issues`,
          body: { issue: args.issue },
        },
        ctx,
      );
      if (!link.answer.ok) return halt(link);
      landed.push({
        door: doorName(link.request),
        did: `Linked ${args.issue} to ${requirement}, which it delivers`,
        wrote: cite('requirement', requirement),
        undo: {
          door: `DELETE /api/projects/${ctx.projectId}/requirements/${requirement}/issues/${issue.id}`,
          body: null,
        },
      });
    }

    const plan = await send(
      { method: 'PATCH', path: `/api/issues/${issue.id}`, body: { plan: args.plan } },
      ctx,
    );
    if (!plan.answer.ok) return halt(plan);
    landed.push({
      door: doorName(plan.request),
      did: `Saved ${args.issue}'s plan against ${requirement} revision ${req.currentRevision}`,
      wrote: cite('issue', args.issue),
      undo: { door: `PATCH /api/issues/${issue.id}`, body: { plan: issue.plan ?? null } },
    });

    const criteria = await send(
      {
        method: 'PUT',
        path: `/api/issues/${issue.id}/criteria`,
        body: {
          criteria: args.criteria.map((c) => ({
            statement: c.statement,
            requirementCriterionId: bcs.get(c.bc.toUpperCase())?.id ?? null,
          })),
        },
      },
      ctx,
    );
    if (!criteria.answer.ok) return halt(criteria);
    landed.push({
      door: doorName(criteria.request),
      did: `Wrote ${args.criteria.length} criteria on ${args.issue}, traced to ${[...new Set(args.criteria.map((c) => c.bc.toUpperCase()))].join(', ')} of ${requirement}`,
      wrote: cite('issue', args.issue),
      undo: { door: `PUT /api/issues/${issue.id}/criteria`, body: { criteria: priorCriteria } },
    });

    // the answer is the issue-ready check as the draft now stands, which `steward_decide` reads too
    const ready = await send({ method: 'GET', path: `/api/issues/${issue.id}/checklist` }, ctx);
    return { ...ready, acts: landed };
  },
};
