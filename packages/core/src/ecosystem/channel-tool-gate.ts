import { RefusalError } from '../lib/refusal.js';
import { answerAs, openGateQuestionsOf } from '../questions/index.js';
import type { Writer } from './channel-author.js';
import { readAs } from './channel-read.js';
import { viewOf } from './channel-view.js';

export interface NamedRefusal {
  code: string;
  path: string;
  detail: string;
}

type GateOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; refusals: NamedRefusal[] };

const no = (code: string, path: string, detail: string): GateOutcome => ({
  ok: false,
  refusals: [{ code, path, detail }],
});

// cm:why the gate is decided only by answering its question through `answerAs`, the call `POST /api/questions/:id/answer` makes, so the option's authority (PERMISSION_FORBIDDEN) and the note rule are the question's own
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
  const question = (
    await openGateQuestionsOf([{ projectId: args.side, documentId: args.documentId }])
  ).get(args.documentId);
  if (!question) {
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
      round: question.round,
      userId,
      via: author.via,
      ...(args.note === undefined ? {} : { note: args.note }),
    });
  } catch (err) {
    if (err instanceof RefusalError) return { ok: false, refusals: [...err.refusals] };
    throw err;
  }
  return {
    ok: true,
    value: { question: question.id, ...viewOf(await readAs(args.side, args.documentId)) },
  };
}
