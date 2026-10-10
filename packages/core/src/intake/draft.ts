/**
 * One intake draft (REQ-34 BC-10..BC-16), the pattern of `questions/suggest-answer.ts`: the four
 * reads, one tool-less completion through the deployment's provider under the project's data policy,
 * the answer judged against what was read, one retry carrying the refusal. A miss is returned by
 * code, never thrown; whether it is tried again is the service's call (`service.ts`). Everything it
 * touches comes in through `deps`, so a test can see every read it makes.
 */

import type { ContentLanguageView } from '@forge/contracts/content-language';
import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  type IntakeDraftCode,
  type IntakeRead,
  intakeAnswerSchema,
} from '@forge/contracts/intake-drafts';
import type {
  ChatMessage,
  ChatStreamUsage,
  CompletionAnswer,
  completeOnce,
} from '../integrations/llm/index.js';
import { withheldAt } from '../lib/data-egress.js';
import { intakeSystemPrompt, intakeUserMessage } from './prompt.js';
import type { IntakeItem, IntakeReads, IntakeRecord } from './reads.js';
import { type JudgedDraft, judgeDraft, type ShownRecord, workflowsTouched } from './rules.js';

/** A hung provider cannot hold a delivery longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;

export interface DraftDeps {
  reads: IntakeReads;
  complete: typeof completeOnce;
  level: SensitiveDataLevel;
  language: ContentLanguageView;
  /** A feedback draft's triage checked by the suggestion payload's schema: null when it parses. */
  triageFault: (triage: unknown) => string | null;
}

export interface Spent {
  model: string;
  usage: ChatStreamUsage;
}

export type DraftOutcome = {
  read: Record<IntakeRead, number>;
  model: string | null;
  spent: Spent[];
} & (
  | { outcome: 'drafted'; draft: JudgedDraft }
  | { outcome: 'failed'; code: IntakeDraftCode; detail: string }
);

const MISS: Record<
  Extract<CompletionAnswer, { ok: false }>['miss'],
  { code: IntakeDraftCode; detail: (d: string) => string }
> = {
  unconfigured: {
    code: 'INTAKE_MODEL_UNCONFIGURED',
    detail: () => 'no chat model is configured on this instance, so nothing was drafted',
  },
  withheld: {
    code: 'INTAKE_WITHHELD',
    detail: () =>
      "the project's data policy forbids sending this item to a model, so its master drafts it",
  },
  failed: {
    code: 'INTAKE_MODEL_FAILED',
    detail: (d) => `the model call failed (${d.slice(0, 160)})`,
  },
};

function parse(text: string): ReturnType<typeof intakeAnswerSchema.safeParse> | string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return 'the answer is not one JSON object';
  try {
    return intakeAnswerSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return 'the answer is not valid JSON';
  }
}

export async function draftIntake(item: IntakeItem, deps: DraftDeps): Promise<DraftOutcome> {
  const [requirements, workflows, feedback, releases] = await Promise.all([
    deps.reads.requirements(item),
    deps.reads.workflows(item),
    deps.reads.feedback(item, { withText: !withheldAt(deps.level, 'feedback') }),
    deps.reads.releases(item),
  ]);
  const read = {
    requirements: requirements.length,
    workflows: workflows.length,
    feedback: feedback.length,
    releases: releases.length,
  };
  const known = new Map<string, ShownRecord>(
    [...requirements, ...workflows, ...feedback, ...releases].map((r: IntakeRecord) => [r.ref, r]),
  );
  const touched = workflowsTouched(item, workflows);
  const messages: ChatMessage[] = [
    { role: 'system', content: intakeSystemPrompt(item.kind, deps.language) },
    {
      role: 'user',
      content: intakeUserMessage(item, { requirements, workflows, feedback, releases }, touched),
    },
  ];
  // a feedback item is what people send in: the policy reads it as operational, a requirement as product
  const scope = {
    surface: item.kind === 'feedback' ? ('feedback' as const) : ('requirement' as const),
    level: deps.level,
    what: `the intake draft of ${item.key}`,
  };
  const spent: Spent[] = [];
  let model: string | null = null;
  for (const attempt of [1, 2]) {
    const answer = await deps.complete(scope, messages, {
      temperature: 0,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (answer.model) model = answer.model;
    if (!answer.ok) {
      const miss = MISS[answer.miss];
      return {
        outcome: 'failed',
        code: miss.code,
        detail: miss.detail(answer.detail),
        read,
        model,
        spent,
      };
    }
    spent.push({ model: answer.model, usage: answer.usage });
    const parsed = parse(answer.text);
    let refused: string[];
    if (typeof parsed === 'string') refused = [parsed];
    else if (!parsed.success) {
      refused = parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`);
    } else {
      const judged = judgeDraft(parsed.data, {
        item,
        known,
        touched,
        triageFault: deps.triageFault,
      });
      if (judged.ok) return { outcome: 'drafted', draft: judged.draft, read, model, spent };
      refused = judged.faults;
    }
    const why = refused.slice(0, 12).join('; ');
    if (attempt === 2) {
      return {
        outcome: 'failed',
        code: 'INTAKE_SHAPE',
        detail: why.slice(0, 1000),
        read,
        model,
        spent,
      };
    }
    messages.push(
      { role: 'assistant', content: answer.text },
      { role: 'user', content: `That was refused: ${why}. Answer again as one JSON object.` },
    );
  }
  throw new Error('intake: the draft loop ended without an outcome');
}
