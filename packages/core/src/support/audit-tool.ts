// forge_audit: a master's or run's audit of its own output (ISS-1251 c4), the act a room agent has as
// support.audit, under the same shape and into the same verdict store. Its one action, `audit.self`,
// calls what its REST twin `POST /api/projects/:id/self-audits` calls (`reply-audit/self-audit.ts`).
// The card teaches when to audit; nothing here makes an agent do it. The steward audits in its own
// done call (`steward/routes.ts`), since that call ends its job and its token.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import {
  ROLE_RUBRICS,
  SELF_AUDIT_SHAPE,
  selfAuditRequestShape,
} from '@forge/contracts/support-reply-audit';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import {
  type ContextScopedMcpToolFactory,
  refusedAnswer,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { onArg } from '../permissions/index.js';
import { auditOwnWork } from './reply-audit/self-audit.js';

const ACTIONS = ['self'] as const;

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid(),
  ...selfAuditRequestShape,
});

const rubric = (role: 'master' | 'run') => Object.keys(ROLE_RUBRICS[role]).join(', ');

const DESCRIPTION = [
  `self ${SELF_AUDIT_SHAPE}: audit your own finished output once, as the role whose rubric you hold.`,
  `failed names each rubric line it fails (master: ${rubric('master')}; run: ${rubric('run')}) or the card whose red flag you tripped ({ redFlag: <door>, why }); [] where it fails none.`,
  'missed names each capability you should have reached for, by its forge_find name. Each door is read against the catalog and an unknown one refused SELF_AUDIT_DOOR_UNKNOWN; nothing is kept on a refusal.',
  'A failed verdict becomes a correction on the issue, which the steward draws lessons from; the capabilities page counts your misses. A second audit of one output in one role answers the first, already: true.',
].join(' ');

/** When a master or run reaches for its self-audit (ISS-1251), from the room agent's support.audit. */
const CARDS = {
  self: {
    purpose:
      'Scores your own finished output against your role’s rubric and your cards’ red flags, and names what you missed.',
    situations: [
      {
        when: 'an issue you built or landed is closed or handed on, and your report is written',
        do: 'audit it once with audit.self { as, output: { kind: issue, ref }, failed, missed? }; failed is [] where every line holds',
      },
      {
        when: 'you did what a card’s red flag warns of while you worked',
        do: 'name it in failed as { redFlag: <that door>, why }, beside the rubric lines you failed',
      },
      {
        when: 'you see an act you should have reached for and did not',
        do: 'name it in missed by its forge_find name, with why, so its card is counted',
      },
    ],
    practice: [
      'A failed line becomes a lesson’s raw material: say why in one line a stranger can check.',
      'One audit per output and role; a second answers the first unchanged.',
      'The steward audits in its done call, { failed, missed } beside refused, never here.',
    ],
    example: {
      projectId: '<project uuid>',
      as: 'run',
      output: { kind: 'issue', ref: 'ISS-1251' },
      failed: [
        { line: 'criteria_proven', why: 'criterion 3 closed on a unit test, never on the page' },
      ],
      missed: [{ door: 'feedback.door', why: 'a guide left me guessing and I did not say so' }],
    },
    // ISS-1251 judge, 2026-11-16 at 4efa1e10: misses came only from room agents; no master or run had
    // an act to audit its own output, so their misses read nowhere
    redFlag:
      'Closing work and moving on with no audit, or auditing failed: [] while a criterion stood on no proof.',
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['masters and runs closing work with no audit, their misses read nowhere'],
  },
} satisfies Record<string, CapabilityCardBody>;

const refused = (issues: readonly z.core.$ZodIssue[]) =>
  refusedAnswer(
    issues.map((i) => ({
      code: 'BAD_REQUEST',
      path: `/${i.path.join('/')}`,
      detail: `${i.message}; audit.self takes ${SELF_AUDIT_SHAPE}`,
    })),
    'SELF_AUDIT_REFUSED',
  );

export const forgeAuditTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_audit',
  reach: 'project',
  route: '/api/projects',
  grant: { byAction: { self: 'projects:write' } },
  permission: { byAction: { self: onArg('project.write') } },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  cards: CARDS,
  source: sourceOf(import.meta.url),
  handler: async (args) => {
    const input = inputSchema.safeParse(args);
    if (!input.success) return refused(input.error.issues);
    const { action: _action, projectId, ...request } = input.data;
    const out = await auditOwnWork(
      projectId,
      { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) },
      request,
    );
    return out.ok ? out.value : refusedAnswer(out.refusals, 'SELF_AUDIT_REFUSED');
  },
});
