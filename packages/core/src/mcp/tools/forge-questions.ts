import { z } from 'zod';
import { loadIssueProjectId } from '../../comments/service.js';
import {
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
} from '../../db/question-vocabulary.js';
import { askAs, readQuestionFor, readQuestionsForIssue } from '../../questions/read.js';
import { QuestionRefused } from '../../questions/write.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  zodToMcpSchema,
} from './lib.js';

const optionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(500),
    authority: z.enum(optionAuthorities),
    bindsTo: z.enum(optionBindings),
    executedBy: z.enum(optionExecutors),
    fingerprint: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const askDataSchema = z
  .object({
    issueId: z.uuid(),
    prompt: z.string().trim().min(1).max(8000),
    blockerKind: z.enum(questionBlockerKinds),
    options: z.array(optionSchema).max(10).optional(),
    recommendedOptionId: z.string().trim().min(1).max(100).optional(),
    needed: z.string().trim().min(1).max(2000).optional(),
    assumed: z.record(z.string(), z.unknown()).optional(),
    maxRounds: z.number().int().min(1).max(10).optional(),
    parkDeadlineAt: z.iso.datetime().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

const inputSchema = z
  .object({
    action: z.enum(['ask', 'get', 'list']),
    id: z.uuid().optional(),
    issueId: z.uuid().optional(),
    data: askDataSchema.optional(),
  })
  .strict();

type AskData = z.infer<typeof askDataSchema>;

function answerOf(data: AskData) {
  const choice = data.options !== undefined || data.recommendedOptionId !== undefined;
  if (choice && data.needed !== undefined) {
    throw new Error(
      'BAD_REQUEST: send `options` + `recommendedOptionId` for a choice, or `needed` for a free-text answer — not both',
    );
  }
  if (choice) {
    return {
      shape: 'choice' as const,
      options: (data.options ?? []).map(({ fingerprint, ...o }) =>
        fingerprint ? { ...o, fingerprint } : o,
      ),
      recommendedOptionId: data.recommendedOptionId ?? '',
    };
  }
  if (data.needed === undefined) {
    throw new Error(
      'BAD_REQUEST: a question carries its answer shape — `options` + `recommendedOptionId` for a choice, or `needed` (what would settle it) for free text',
    );
  }
  return { shape: 'free_text' as const, needed: data.needed };
}

function refused(err: unknown): unknown {
  if (err instanceof QuestionRefused) return new Error(`${err.code}: ${err.message}`);
  return err;
}

export const forgeQuestionsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_questions',
  description:
    'Ask a person (or a peer agent) a question against an issue, and read questions back. ' +
    'action=ask — data={issueId, prompt, blockerKind:"human"|"master_or_peer"|"machine", then EITHER ' +
    'options:[{id,label,authority:"writer"|"admin",bindsTo:"this_call"|"session"|"project",executedBy:"agent"|"core"|"human",fingerprint?}] + recommendedOptionId ' +
    'OR needed:"<what would settle it>"; optional assumed, maxRounds, parkDeadlineAt, sensitive}. ' +
    'An ask writes the question and moves no status, whatever the blocker kind: the issue keeps its rung, and an open "human" question marks it as waiting on a person on the Issues list, in Needs you and in Attention. ' +
    'To stop work for want of a requirement, park it with forge_issues at `needs_info` as well; that park asks nothing twice. ' +
    'Asking on a closed or dropped issue is refused (QUESTION_ISSUE_TERMINAL). ' +
    'A closed or dropped move is refused while a question is open: answer it, or send the close with `voidQuestions` on forge_issues. ' +
    'action=get — id=<question uuid>. action=list — issueId=<issue uuid>, every question on that issue, newest first. ' +
    'Requires writer role to ask and member role to read; answering is a person’s, from the issue screen.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (raw: unknown) => {
    const input = inputSchema.parse(raw);
    const { principal } = ctx;
    switch (input.action) {
      case 'ask': {
        if (!input.data) throw new Error('BAD_REQUEST: data is required for ask');
        const data = input.data;
        const projectId = await loadIssueProjectId(data.issueId);
        await assertPrincipalIsWriter(principal, projectId);
        try {
          const asked = await askAs({
            userId: principal.userId,
            issueId: data.issueId,
            prompt: data.prompt,
            blockerKind: data.blockerKind,
            answer: answerOf(data),
            assumed: data.assumed,
            maxRounds: data.maxRounds,
            parkDeadlineAt: data.parkDeadlineAt ? new Date(data.parkDeadlineAt) : undefined,
            sensitive: data.sensitive,
          });
          if (!asked) throw new Error('NOT_FOUND: issue not found');
          return asked;
        } catch (err) {
          throw refused(err);
        }
      }
      case 'get': {
        if (!input.id) throw new Error('BAD_REQUEST: id is required for get');
        const seen = await readQuestionFor(input.id, principal.userId);
        if (!seen) throw new Error('NOT_FOUND: question not found');
        await assertPrincipalIsMember(principal, seen.projectId);
        return seen;
      }
      case 'list': {
        if (!input.issueId) throw new Error('BAD_REQUEST: issueId is required for list');
        const projectId = await loadIssueProjectId(input.issueId);
        await assertPrincipalIsMember(principal, projectId);
        const rows = await readQuestionsForIssue(input.issueId, principal.userId);
        return { questions: rows ?? [] };
      }
    }
  },
});
