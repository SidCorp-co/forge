// What a turn that ended without its answer still hands the person: why it stopped, in their
// language, the calls that landed, from its own ledger, and the draft it had streamed when that
// draft passes the same screen a reply does. Code writes the frame, so it states nothing the turn
// did not do; the draft is the model's, so it goes out only screened, its proof carried into the frame.

import {
  codeAuthored,
  failedTurnReport,
  findingsWords,
  type ReplyLanguage,
  type ScreenedMessage,
  screened,
  type TurnFailureCause,
  type TurnFailureCode,
} from '../conversations/index.js';
import { logger } from '../lib/logger.js';
import type { DoorId } from '../messaging/contract.js';
import type { ProgressFacts } from '../messaging/facts.js';
import { reframed } from '../messaging/proven.js';
import { repairIssueLinks } from '../messaging/reply-marks.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { withReplyLanguage } from './screened-reply.js';
import { ledgerLines } from './turn-partial.js';
import type { DoneCall } from './turn-writes.js';

export interface FailureReportArgs {
  door: DoorId;
  projectId: string;
  /** The handle the report speaks as. */
  name: string;
  /** The language the report is written in: the asker's. */
  language: ReplyLanguage;
  /** The language the person wrote in, where it can be told; the draft is held to it. */
  askedIn: ReplyLanguage | null;
  code: TurnFailureCode;
  cause: TurnFailureCause;
  calls: readonly DoneCall[];
  /** The text the turn had streamed in its last round, or nothing. */
  draft: string | null;
  toolResults: readonly string[];
  progress: ProgressFacts | null;
  log?: Record<string, unknown>;
}

/** The draft admitted by the reply screen, or null where it fails it or cannot be screened. */
async function screenedDraft(
  args: FailureReportArgs,
  draft: string,
): Promise<ScreenedMessage | null> {
  try {
    const verdict = await screenReplyAtDoor(args.door, {
      projectId: args.projectId,
      segments: [draft],
      toolCalls: args.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
      progress: args.progress,
      toolResults: args.toolResults,
    });
    const judged = withReplyLanguage(verdict, draft, args.askedIn, args.log);
    return judged.ok ? screened(draft, args.door, judged) : null;
  } catch (err) {
    logger.warn(
      { err, ...args.log },
      'conversations: the draft of a failed turn could not be screened',
    );
    return null;
  }
}

/** The report a failed turn posts, with its draft's proof carried into the frame where one is shown. */
export async function failureReport(args: FailureReportArgs): Promise<ScreenedMessage> {
  const words = findingsWords(args.language);
  const parts: string[] = [];
  const ledger = ledgerLines(args.calls, args.language);
  if (ledger.length > 0) parts.push(ledger.join('\n'));
  const draft = args.draft ? repairIssueLinks(args.draft).trim() : '';
  const shown = draft ? await screenedDraft(args, draft) : null;
  if (shown) parts.push(`${words.draft}\n\n${shown.text}`);
  else if (draft) parts.push(words.unchecked);
  const text = failedTurnReport({
    name: args.name,
    language: args.language,
    code: args.code,
    cause: args.cause,
    findings: parts.length > 0 ? parts.join('\n\n') : null,
  });
  if (!shown?.proof) return codeAuthored(text);
  return { text, proof: reframed(shown.proof, text) };
}
