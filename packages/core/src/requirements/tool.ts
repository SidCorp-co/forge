import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { MCP_DOOR } from '../lib/data-egress.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { criteriaFromDocument } from './document-criteria.js';
import { designsNamed, draftLinked } from './draft-linked.js';
import { listRequirementsAs, readRequirementAs } from './read.js';
import { revisionFields } from './route-kit.js';
import { writeRevision } from './service.js';
import type { RequirementOutcome } from './write-tx.js';

// One tool, one read, each one object: the chat adapter pins the session's projectId and drops
// undeclared keys by the schema's top-level properties (assistant/tools/mcp-adapter.ts:buildToolset).
// A list and a get behind one `action` asked the model for a field the other act takes, and it
// filled it ("REQ-1" on a list), so the list and the get are two tools.
const listInput = z.strictObject({ projectId: z.uuid() });
const getInput = z.strictObject({
  projectId: z.uuid(),
  requirement: z
    .string()
    .regex(/^REQ-\d+$/, 'a requirement is named by its key, REQ-n')
    .describe('the requirement key, e.g. REQ-12'),
});

type Actor = { userId: string; agency: ReturnType<typeof principalAgency> };
const actorOf = (ctx: Parameters<ContextScopedMcpToolFactory>[0]): Actor => ({
  userId: ctx.principal.userId,
  agency: principalAgency(ctx.principal),
});

export const forgeRequirementsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirements',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    "This project's requirements (REQ-n), as the Requirements screen lists them: each with its state (draft, agreed, in_delivery, delivered, accepted, deferred, dropped), whom it waits on and the act, its BCs proven of total, and its shipped/started/live issues. forge_requirement reads one in full.",
  inputSchema: zodToMcpSchema(listInput),
  handler: async (args) => {
    const { projectId } = listInput.parse(args);
    const list = await listRequirementsAs(actorOf(ctx), projectId);
    return {
      requirements: list.map((r) => ({
        key: r.key,
        title: r.title,
        state: r.standing.state,
        waitingOn: r.standing.waitingOn,
        criteria: {
          proven: r.delivery.criteriaCoverage.passing,
          judged: r.delivery.criteriaCoverage.judged,
          total: r.delivery.criteriaCoverage.criteria,
        },
        issues: {
          shipped: r.delivery.closedIssues,
          started: r.delivery.startedIssues,
          live: r.delivery.liveIssues,
        },
        touchedAt: r.standing.touchedAt,
      })),
    };
  },
});

export const forgeRequirementTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:read',
  description:
    "One requirement (`requirement`: REQ-12) as its page reads it: its current revision (goal, scope, BCs), each BC's proof and the issues tracing it, its issues with the release that shipped each, the releases it shipped in, its open tasks, a deferral's reason, and whom it waits on.",
  inputSchema: zodToMcpSchema(getInput),
  handler: async (args) => {
    const { projectId, requirement } = getInput.parse(args);
    const r = await readRequirementAs(actorOf(ctx), projectId, requirement, MCP_DOOR);
    const current = r.revisions.find((v) => v.revision === r.currentRevision) ?? r.revisions[0];
    return {
      key: r.key,
      title: r.title,
      state: r.standing.state,
      waitingOn: r.standing.waitingOn,
      tasks: r.standing.tasks,
      currentRevision: r.currentRevision,
      revisions: r.revisions.length,
      spec: current?.spec ?? null,
      tldr: current?.tldr ?? null,
      coverage: r.standing.coverage,
      issues: r.issues.map((i) => ({
        key: i.displayId,
        title: i.title,
        status: i.status,
        shippedIn: i.shippedIn,
      })),
      releases: r.releases,
      deferral: r.deferral,
      lastAgreed: r.baselines[0]
        ? { by: r.baselines[0].agreedByName, at: r.baselines[0].agreedAt }
        : null,
    };
  },
});

// A BA's or an owner's wish about how the product should behave, recorded from a chat as a draft
// Requirement or a draft revision of one (owner ruling 2026-10-08): never an issue, and only after
// the person confirmed what the chat restated. Both land at draft; a person proposes and accepts.
const requirementKey = z
  .string()
  .regex(/^REQ-\d+$/, 'a requirement is named by its key, REQ-n')
  .describe('the requirement key, e.g. REQ-12');
const criteriaFrom = z
  .strictObject({
    file: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe('the attached file name exactly as the conversation shows it, e.g. spec.md'),
    section: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'the heading whose list holds the criteria, e.g. "Acceptance criteria"; leave it out when the whole file is the list',
      ),
  })
  .describe(
    'Take the criteria from a document attached in this conversation, each list item verbatim, instead of writing `criteria`: a prose line is reported as skipped with its number, and a list item that cannot be taken is refused by its number. Send `criteria: []` with it.',
  );
const draftInput = z.strictObject({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(500),
  ...revisionFields,
  criteria: revisionFields.criteria.default([]),
  criteriaFrom: criteriaFrom.optional(),
  designs: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .optional()
    .describe(
      'the workflow designs this wish relates to, by flow name (e.g. chat-turn) or id: the draft is linked to each',
    ),
  preview: z
    .boolean()
    .optional()
    .describe(
      'with criteriaFrom: write nothing, and answer how many criteria the file gives and from which lines, to show the person before they confirm',
    ),
});
const reviseInput = z.strictObject({
  projectId: z.uuid(),
  requirement: requirementKey,
  baseRevision: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('the head revision you read with forge_requirement (currentRevision)'),
  ...revisionFields,
});

function drafted(outcome: RequirementOutcome) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'REQUIREMENT_REFUSED');
  const r = outcome.requirement;
  return {
    requirement: { key: r.key, title: r.title, state: r.standing.state },
    revisions: r.revisions.map((v) => ({ revision: v.revision, state: v.state })),
  };
}

const WRITE_RULE =
  "From a chat this call is held for the person's agreement: core keeps it as a proposal they see as a confirm card, and writes it as them once they agree. Criteria are statements a person can check; what the input leaves unsettled goes in spec.openQuestions, never settled by you.";

export const forgeRequirementDraftTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement_draft',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: `Draft a NEW requirement (REQ-n at revision 1, draft) for a wish about how the product should behave that no existing requirement covers — look with forge_requirements first, and revise the one that covers it instead. ${WRITE_RULE} Where the criteria are an attached document's list, take them with criteriaFrom, never retyped: call with preview: true first, tell the person the count and the lines, then call it without preview.`,
  inputSchema: zodToMcpSchema(draftInput),
  handler: async (args) => {
    const { projectId, title, criteriaFrom, preview, designs, ...write } = draftInput.parse(args);
    const linked = await designsNamed(projectId, designs ?? []);
    if (!linked.ok) return refusedAnswer([linked.refusal], 'REQUIREMENT_REFUSED');
    const draft = (criteria: typeof write.criteria) =>
      draftLinked({
        projectId,
        actor: actorOf(ctx),
        title,
        write: { ...write, criteria },
        workflowIds: linked.ids,
      });
    if (!criteriaFrom) {
      if (preview) return documentRefusal('preview reads criteriaFrom, and this call names none');
      return drafted(await draft(write.criteria));
    }
    const taken = await documentCriteria(ctx, criteriaFrom, write.criteria.length);
    if (!taken.ok) return documentRefusal(taken.detail);
    if (preview) return { preview: previewOf(criteriaFrom, taken.criteria, taken.skipped) };
    const filed = drafted(await draft(taken.criteria.map(({ body }) => ({ body }))));
    return 'requirement' in filed
      ? { ...filed, taken: takenFigures(taken.criteria, taken.skipped) }
      : filed;
  },
});

function documentRefusal(detail: string) {
  return refusedAnswer(
    [{ code: 'CRITERIA_DOCUMENT_REFUSED', path: '/criteriaFrom', detail }],
    'REQUIREMENT_REFUSED',
  );
}

type Skipped = { line: number; text: string }[];
type Taken =
  | { ok: true; criteria: { body: string; line: number }[]; skipped: Skipped }
  | { ok: false; detail: string };

/** The criteria a document attached in this turn's room gives, verbatim, or the line it could not take. */
async function documentCriteria(
  ctx: Parameters<ContextScopedMcpToolFactory>[0],
  from: z.infer<typeof criteriaFrom>,
  written: number,
): Promise<Taken> {
  if (written > 0) {
    return {
      ok: false,
      detail: `this call names ${written} criteria and criteriaFrom both; the criteria come from one place — send criteria: [] to take them from ${from.file}`,
    };
  }
  const read = ctx.turn?.readDocument;
  if (!read) {
    return {
      ok: false,
      detail:
        'criteriaFrom reads a document attached in a conversation, and this call was not made from one',
    };
  }
  const doc = await read(from.file);
  if (!doc.ok) return { ok: false, detail: doc.reason };
  const parsed = criteriaFromDocument(doc.text, { file: doc.name, section: from.section });
  return parsed.ok ? parsed : { ok: false, detail: parsed.detail };
}

const PREVIEW_ENDS = 3;

const SKIPPED_SHOWN = 20;

/** The count as a sentence to copy, so no model recounts the list; and the lines left out, by number. */
function takenFigures(criteria: { body: string; line: number }[], skipped: Skipped) {
  const first = criteria[0]?.line ?? 0;
  const last = criteria[criteria.length - 1]?.line ?? 0;
  const left =
    skipped.length === 0
      ? 'no line was left out'
      : `${skipped.length} line${skipped.length === 1 ? '' : 's'} skipped, not a list item (${skipped
          .slice(0, SKIPPED_SHOWN)
          .map((s) => s.line)
          .join(', ')}${skipped.length > SKIPPED_SHOWN ? ', …' : ''})`;
  return {
    count: criteria.length,
    say: `exactly ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'}, from lines ${first}-${last}; ${left}`,
    skipped: skipped.slice(0, SKIPPED_SHOWN).map((s) => ({
      line: s.line,
      text: s.text.length > 120 ? `${s.text.slice(0, 117)}…` : s.text,
      reason: 'skipped, not a list item',
    })),
  };
}

function previewOf(
  from: z.infer<typeof criteriaFrom>,
  criteria: { body: string; line: number }[],
  skipped: Skipped,
) {
  const first = criteria[0]?.line ?? 0;
  const last = criteria[criteria.length - 1]?.line ?? 0;
  return {
    file: from.file,
    ...(from.section ? { section: from.section } : {}),
    criteria: criteria.length,
    lines: `${first}-${last}`,
    ...takenFigures(criteria, skipped),
    first: criteria.slice(0, PREVIEW_ENDS),
    last: criteria.length > PREVIEW_ENDS * 2 ? criteria.slice(-PREVIEW_ENDS) : [],
    written: false,
  };
}

export const forgeRequirementReviseTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_requirement_revise',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: `Draft a revision of an EXISTING requirement (REQ-n) a wish changes: read it with forge_requirement first and write the whole revision on top of its head — every criterion that stays, kept with its code, plus the change. ${WRITE_RULE}`,
  inputSchema: zodToMcpSchema(reviseInput),
  handler: async (args) => {
    const { projectId, requirement, baseRevision, ...write } = reviseInput.parse(args);
    return drafted(
      await writeRevision({
        projectId,
        ref: requirement,
        actor: actorOf(ctx),
        baseRevision,
        write,
      }),
    );
  },
});
