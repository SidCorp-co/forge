import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { Refused } from '../../ecosystem/channel-act.js';
import type { Writer } from '../../ecosystem/channel-author.js';
import { readAs } from '../../ecosystem/channel-read.js';
import { viewOf } from '../../ecosystem/channel-view.js';
import { answerAs } from '../../questions/read.js';
import { QuestionRefused } from '../../questions/write.js';

export interface NamedRefusal {
  code: string;
  path: string;
  detail: string;
}

export type GateOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; refusals: NamedRefusal[] };

const no = (code: string, path: string, detail: string): GateOutcome => ({
  ok: false,
  refusals: [{ code, path, detail }],
});

// cm:why the gate is decided only by answering its question through `answerAs`, the call `POST /api/questions/:id/answer` makes, so the option's authority (QUESTION_AUTHORITY_REQUIRED) and the note rule are the question's own
export async function decideGateAs(args: {
  side: string;
  documentId: string;
  decision: 'approve' | 'return';
  note: string | undefined;
  writer: Writer;
}): Promise<GateOutcome> {
  const { author, userId } = args.writer;
  if (author.kind !== 'person') {
    return no('QUESTION_NEEDS_SESSION', '/decision', 'an approve gate is decided by a person');
  }
  const [question] = await db
    .select({ id: agentQuestions.id, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.projectId, args.side),
        eq(agentQuestions.status, 'open'),
        sql`${agentQuestions.origin}->>'kind' = 'channel_gate'`,
        sql`${agentQuestions.origin}->>'documentId' = ${args.documentId}`,
      ),
    )
    .limit(1);
  const round = question?.steps.at(-1)?.round;
  if (!question || round === undefined) {
    return no(
      'GATE_NOT_PENDING',
      '/ref',
      `no open approve gate on document ${args.documentId} sent by project ${args.side}; only a submitted document waiting at the gate is decided`,
    );
  }
  try {
    await answerAs({
      questionId: question.id,
      answer: { kind: 'option', optionId: args.decision },
      round,
      userId,
      via: author.via,
      ...(args.note === undefined ? {} : { note: args.note }),
    });
  } catch (err) {
    if (err instanceof QuestionRefused) return no(err.code, '/decision', err.message);
    if (err instanceof Refused) return { ok: false, refusals: err.refusals };
    throw err;
  }
  return {
    ok: true,
    value: { question: question.id, ...viewOf(await readAs(args.side, args.documentId)) },
  };
}
