// The shape of one conversation turn: what the transport hands the runner, the hooks it may
// divert through, and how the turn ended.

import type {
  ConversationVenue,
  ReplyLanguage,
  ScreenedMessage,
  TurnFailureCause,
  TurnFailureCode,
} from '../conversations/index.js';
import type { TurnAuthority, TurnCredential } from '../credentials/turn-credential.js';
import type { ChatStreamEvent } from '../integrations/llm/index.js';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import type { BlockStage, DroppedBlock, StagedBlock } from '../lib/staged-block.js';
import type { DoorId } from '../messaging/contract.js';
import type { ExternalChatTurnResult } from './external-chat.js';
import type { ChatToolset } from './tools/mcp-adapter.js';
import type { DocumentResolver } from './turn-documents.js';
import type { ImageResolver, TurnImage } from './vision.js';

/** What the transport contributes to a turn beyond the message itself. */
export interface TurnInputs {
  tools?: ChatToolset | undefined;
  persona?: string | null;
  conversationContext?: string | null;
  /** The page the person sees beside the chat, rendered above their newest message (ISS-47). */
  pageContext?: Record<string, unknown> | null;
  images?: readonly TurnImage[] | undefined;
  /**
   * The images a record this turn writes carries (a Feedback item, a comment's attachments), kept
   * with a write held for the person's agreement so the agreed write carries them too.
   */
  recordImages?: readonly TurnImage[] | undefined;
  resolveImage?: ImageResolver | undefined;
  resolveDocument?: DocumentResolver | undefined;
}

/** What a hook is given: the phase name the report will carry, the turn's abort, and whose authority it runs under. */
export interface TurnHookContext {
  setPhase: (phase: string) => void;
  signal: AbortSignal;
  /** The person this turn answers and acts as; `authority.userId` is who every tool runs as. */
  authority: TurnAuthority;
  principalUserId: string;
  /**
   * The token minted for that person for this turn, minted on first call and revoked when the
   * turn ends; throws a turn-authority refusal where their grant leaves the tools nothing.
   */
  credential: () => Promise<TurnCredential>;
  /** The linked author of the newest person message, or null when nobody Forge knows (ISS-1034). */
  speakerUserId: string | null;
  /** The room this turn answers in, for the tools that write on the speaker's behalf. */
  conversationId: string;
  /** The handle answering for the venue's project in this room, or null where none is in it. */
  handleUserId: string | null;
  /** Where a block the turn draws waits until its reply is judged; a door that draws blocks hands it to its tools. */
  blockStage: BlockStage;
}

/**
 * The text the screen admitted; `heldPart` where it is the part of a held answer the check passed
 * (REQ-41 BC-3), never a turn's early partial reply.
 */
export interface SettledReply {
  text: string;
  screenReplaced: boolean;
  heldPart?: true;
}

export type TurnReply =
  | { send: false; reason: string; ended?: 'declined' | 'superseded' | 'not-dispatched' }
  /**
   * The turn ended without an answer it chose: a failure, never a silence. `report` is what the
   * person is shown instead: why, in their language, and what the turn did and found.
   */
  | {
      send: false;
      reason: string;
      ended: 'failed';
      code: TurnFailureCode;
      cause: TurnFailureCause;
      report: ScreenedMessage;
    }
  /**
   * `awaitsReply`: the attempt whose text this is called `await_reply`, and the text is the model's
   * own (screened, not code-authored). The row is written with it; nothing reads it from the text.
   */
  | {
      send: true;
      message: ScreenedMessage;
      screenReplaced: boolean;
      awaitsReply?: boolean;
      /** The blocks this reply releases: drawn for the answer whose words it is, posted just above it. */
      blocks?: readonly StagedBlock[];
    };

/**
 * Where a turn that outran its first ceiling streams and records the rest: a fresh entry beside
 * the partial reply already delivered under the first one.
 */
export interface ContinuedEntry {
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  onSettled?: ((settled: SettledReply) => void) | undefined;
  replyEntry?:
    | ((deliveredText: string) => { id: string; blocks: readonly ContentBlock[] | null })
    | undefined;
  close: () => Promise<void>;
}

/** How long a turn runs before it posts what it has, and the most it may run in all. */
export interface TurnBudget {
  partialAfterMs: number;
  ceilingMs: number;
}

export interface ConversationTurnRequest {
  venue: ConversationVenue;
  /** The person whose message this turn answers: whose access it reads and runs its tools under. */
  authority: TurnAuthority;
  /** The transport's own id for the speaker, for the audit row. */
  speakerKey: string;
  speakerUserId?: string | null | undefined;
  handleUserId?: string | null | undefined;
  message: string;
  /** The door the reply goes out of; its row carries the pair and the repair budget. */
  door: DoorId;
  /**
   * The question is already a row, so this turn writes only its silence.
   */
  questionAlreadyRecorded?: boolean;
  /**
   * This turn is allowed to say nothing.
   */
  mayDecline?: boolean;
  /**
   * How the model's answer reaches the venue: as its reply, or only through `room_send`.
   */
  sendMode?: 'reply' | 'tool' | undefined;
  /**
   * What stands when the turn cannot post its answer: the code-authored apology, or nothing.
   */
  fallbacks?: 'post' | 'silence' | undefined;
  /**
   * The person this reply answers, by the label the transport shows for them.
   */
  addressee?: string | null | undefined;
  /**
   * The stable key this turn's delivery answers, so a retry of it delivers nothing.
   */
  deliveryKey?: string;
  /**
   * Called once, immediately before the text is handed to the transport.
   */
  onBeforeDeliver?: () => Promise<boolean>;
  /**
   * Called for each event of the FIRST attempt's turn loop, as it yields.
   */
  onTurnEvent?: ((event: ChatStreamEvent) => void) | undefined;
  /**
   * Called once with the text the screen admitted, before it is delivered.
   */
  onSettled?: ((settled: SettledReply) => void) | undefined;
  /**
   * The identity and the blocks the delivered reply's row is written with.
   */
  replyEntry?:
    | ((deliveredText: string) => { id: string; blocks: readonly ContentBlock[] | null })
    | undefined;
  /**
   * This venue reads whether a reply waits on the person: every attempt is offered `await_reply`,
   * and a reply whose attempt called it is recorded as awaiting an answer (ISS-277).
   */
  recordsAsks?: boolean | undefined;
  /** The answering handle's own name — the code-authored fallbacks speak as it. */
  handleName: string;
  /** The language the code-authored fallbacks answer in: the asker's. */
  replyLanguage?: ReplyLanguage | undefined;
  /**
   * The transport's own inputs, built INSIDE the timeout.
   */
  prepare?: (ctx: TurnHookContext) => Promise<TurnInputs>;
  /**
   * The transport's chance to hand the turn elsewhere before the model runs.
   */
  divertBeforeTurn?: (ctx: TurnHookContext) => Promise<TurnReply | null>;
  /** ...and after it, on what the model actually called. */
  divertAfterTurn?: (
    result: ExternalChatTurnResult,
    ctx: TurnHookContext,
  ) => Promise<TurnReply | null>;
  /**
   * A stop from outside the turn — a person ending it from the room it runs in.
   * Aborting it ends the turn without an answer and without an apology in the
   * thread, which is not what a timeout or a crash does (ISS-1146).
   */
  externalStop?: AbortSignal | undefined;
  /** Released once the turn is over, however it ended. */
  dispose?: () => Promise<void>;
  /**
   * The entry the rest of a turn streams into once a partial reply went out under the first one;
   * absent where the venue streams nothing.
   */
  continueEntry?: (() => ContinuedEntry) | undefined;
  /** The turn's ceilings; the runner's defaults where absent. */
  budget?: Partial<TurnBudget> | undefined;
  log?: Record<string, unknown>;
}

/**
 * How the turn ended, in terms a reader can tell apart.
 */
export type TurnOutcome =
  /**
   * `continuation`: the delivered text was a partial reply; see {@link ContinuedRest}.
   */
  (
    | { kind: 'delivered'; messageId: string | null; continuation?: ContinuedRest }
    | { kind: 'stopped'; reason: string }
    | { kind: 'superseded'; reason: string }
    | { kind: 'diverted'; reason: string }
    | { kind: 'declined'; reason: string }
    | { kind: 'not-dispatched'; reason: string }
    /** `report`: the message the person is owed for it, posted as the window's one terminal status. */
    | {
        kind: 'failed';
        code: TurnFailureCode;
        reason: string;
        cause: TurnFailureCause;
        report: ScreenedMessage;
      }
    /**
     * The composed reply rides along, so a failed delivery does not lose what was written. `reason`
     * is read by every reader of the conversation, so it is a fixed sentence keyed by `code`; the
     * transport's own error goes to logs and error tracking only.
     */
    | { kind: 'undeliverable'; code: typeof REPLY_NOT_DELIVERED; reason: string; reply: string }
  ) & {
    /** The blocks the turn drew that nobody will see, and why: named in the window's record, never silent. */
    droppedBlocks?: readonly DroppedBlock[];
  };

/**
 * The rest of a turn that posted a partial reply. `rest` settles once it has been posted to the same
 * thread, or the line saying why it was not; `until` is the latest it is waited on, past which its
 * window's record says it never settled.
 */
export interface ContinuedRest {
  rest: Promise<TurnOutcome>;
  until: Date;
}

export const REPLY_NOT_DELIVERED = 'REPLY_NOT_DELIVERED';
export const REPLY_NOT_DELIVERED_REASON = 'the reply could not be pushed to this conversation';
