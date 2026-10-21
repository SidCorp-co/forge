import {
  type CreateFeedbackRequest,
  createFeedbackRequestSchema,
  FEEDBACK_LIMITS,
} from '@forge/contracts/feedback';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { type ContextScopedMcpToolFactory, refusedAnswer, zodToMcpSchema } from '../lib/tool.js';
import { addAttachment } from './attachments.js';
import { targetCountRefusal } from './rules.js';
import { createFeedback } from './service.js';

// The chat doors' way in for a person's report or wish (owner ruling 2026-10-08): it enters as
// Feedback, and the issue it may become is a triage's act, never the chat's.
//
// The item's one target is ONE field here, not the REST body's six optional ones: a gateway model
// fills every optional property, so six of them came back filled (or blank) on every call and each
// card failed FEEDBACK_TARGET_NOT_ONE at the person's press (forge-dev chat a760cd5f, 2026-10-21).
const TARGET_KINDS = ['requirement', 'issue', 'release', 'workflow', 'endpoint', 'screen'] as const;
const {
  requirement: _requirement,
  issue: _issue,
  release: _release,
  workflow: _workflow,
  endpoint: _endpoint,
  screen: _screen,
  ...requestFields
} = createFeedbackRequestSchema.shape;
const input = z.strictObject({
  projectId: z.uuid(),
  ...requestFields,
  target: z
    .strictObject({
      kind: z.enum(TARGET_KINDS),
      ref: z.string().trim().min(1).max(FEEDBACK_LIMITS.whereSeen),
    })
    .describe(
      'the ONE thing the item is about: { kind: requirement, ref: "REQ-n" } is best; else issue (ISS-n), release (version), workflow (its slug), endpoint (METHOD /path or tool) or screen (the page route)',
    ),
});
type Input = z.infer<typeof input>;

/** The REST create body the call stands for, its one target under its own field. */
function requestOf({ projectId: _p, target, ...rest }: Input): CreateFeedbackRequest {
  return { ...rest, [target.kind]: target.ref };
}

/**
 * The check the agreement gate runs before it holds a call (`assistant/agreement/vet.ts`): the
 * shape the press would parse, and the one-target rule, so the turn is refused and corrects itself
 * instead of the person pressing Record it on a card that fails. Null to hold it.
 */
async function vetFeedback(args: Record<string, unknown>) {
  const parsed = input.safeParse(args);
  if (!parsed.success) {
    return refusedAnswer(
      parsed.error.issues.map((i) => ({
        code: 'BAD_REQUEST',
        path: `/${i.path.join('/')}`,
        detail: i.message,
      })),
      'FEEDBACK_REFUSED',
    );
  }
  const request = createFeedbackRequestSchema.safeParse(requestOf(parsed.data));
  if (!request.success) {
    return refusedAnswer(
      request.error.issues.map((i) => ({
        code: 'BAD_REQUEST',
        path: `/target/ref`,
        detail: `${parsed.data.target.kind}: ${i.message}`,
      })),
      'FEEDBACK_REFUSED',
    );
  }
  const count = targetCountRefusal(request.data, request.data.whereSeen);
  return count ? refusedAnswer([count], 'FEEDBACK_REFUSED') : null;
}
export const FEEDBACK_RECORD_VETS = { forge_feedback: vetFeedback };

export const forgeFeedbackTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_feedback',
  reach: 'project',
  route: '/api/projects',
  grant: 'projects:write',
  description: [
    "File a person's report or wish as Feedback (FB-n), as the person you are talking to. From a",
    'chat it is held for their agreement: core keeps it as a proposal they see as a confirm card.',
    'kind: bug (something broken or wrong), change_request (different behaviour of something that',
    'exists), idea (something new), question.',
    'Its `target` is the one thing it is about: { kind: "requirement", ref: "REQ-n" } (find it with',
    'forge_requirements first) is best; else screen (the page route), workflow, release, endpoint,',
    'or issue (ISS-n) where nothing better fits.',
    'title says the problem or the wish in the reporter’s terms; body holds what happens, where,',
    'expected vs actual, and the conversation’s link where you have one.',
    'Images the person sent in this turn are attached to it.',
  ].join(' '),
  inputSchema: zodToMcpSchema(input),
  handler: async (args) => {
    const parsed = input.parse(args);
    const { projectId } = parsed;
    const request = requestOf(parsed);
    const actor = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    const filed = await createFeedback({ projectId, actor, request });
    if (!filed.ok) return refusedAnswer(filed.refusals, 'FEEDBACK_REFUSED');
    const attached: string[] = [];
    const notAttached: { name: string; why: string }[] = [];
    for (const image of ctx.turn?.images ?? []) {
      const done = await addAttachment({
        projectId,
        ref: filed.feedback.key,
        actor,
        name: image.name,
        mime: image.mime,
        contentBase64: image.dataBase64,
      });
      if (done.ok) attached.push(image.name);
      else
        notAttached.push({ name: image.name, why: done.refusals.map((r) => r.detail).join(' ') });
    }
    return {
      feedback: {
        key: filed.feedback.key,
        kind: filed.feedback.kind,
        title: filed.feedback.title,
        phase: filed.feedback.phase,
        target: filed.feedback.target,
      },
      ...(attached.length > 0 ? { attached } : {}),
      ...(notAttached.length > 0 ? { notAttached } : {}),
    };
  },
});
