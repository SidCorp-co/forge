import { randomUUID } from 'node:crypto';
import type { ChatStreamEvent } from '../integrations/llm/index.js';
import type { AgentMessage, ContentBlock } from '../lib/agent-stream-parser.js';
import { logger } from '../lib/logger.js';
import {
  publishEphemeralByViewer,
  WEB_CONVERSATION_PROGRESS_EVENT,
} from './conversation-adapter.js';
import { ENTRY_FLUSH_MS, TranscriptAccumulator } from './transcript-entry.js';

/**
 * One tool a turn ran, as a reader who did not ask is shown it: by name, and how long it took once
 * it has returned. Never its input or its output (REQ-32 criterion 6).
 */
interface RoomTool {
  id: string;
  name: string;
  done: boolean;
  durationMs?: number;
  isError?: true;
}

/**
 * What the reply screen settled for the text these frames streamed: `checked` carries the reply
 * that goes out, `withheld` says nothing of the draft went out.
 */
type ProgressVerdict = 'checked' | 'withheld';

/** Everything published under one conversation, so a client can order what it receives. */
interface ConversationProgressFrame {
  conversationId: string;
  /** Monotonic per turn. A client ignores a frame below the highest it has drawn. */
  rev: number;
  /**
   * `asker`: the person the turn acts as, shown the draft and every tool call in full. `room`:
   * everyone else, shown that the turn works and the tools it ran by name, never text or input.
   */
  view: 'asker' | 'room';
  entry: AgentMessage;
  /** The room's view of the tools; absent from the asker's, whose entry carries them in full. */
  tools?: RoomTool[];
  /** Absent while the text streamed is a draft no screen has passed. */
  verdict?: ProgressVerdict;
  /**
   * Set when the text that went out is NOT the prose these frames streamed. Asker's view only.
   */
  replaced?: { draft: string };
}

type AskerFrame = Pick<ConversationProgressFrame, 'entry' | 'verdict' | 'replaced'>;

/** The entry as it stands right now, detached from the accumulator that keeps folding into it. */
function freeze(entry: AgentMessage): AgentMessage {
  return {
    ...entry,
    blocks: (entry.blocks ?? []).map((b) => ({
      ...b,
      ...(b.toolCall ? { toolCall: { ...b.toolCall } } : {}),
      ...(b.todos ? { todos: b.todos.map((t) => ({ ...t })) } : {}),
    })),
    ...(entry.toolCalls ? { toolCalls: entry.toolCalls.map((t) => ({ ...t })) } : {}),
  };
}

/** The tools an entry ran, as the room is shown them. */
function roomToolsOf(entry: AgentMessage): RoomTool[] {
  return (entry.blocks ?? []).flatMap((b) => {
    const call = b.type === 'tool' ? b.toolCall : undefined;
    if (!call) return [];
    const done = call.output !== undefined || call.isError === true;
    return [
      {
        id: call.id,
        name: call.name,
        done,
        ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        ...(call.isError === true ? { isError: true as const } : {}),
      },
    ];
  });
}

/** The asker's frame with every word and every tool input and output taken out. */
function roomViewOf(frame: AskerFrame): Omit<ConversationProgressFrame, 'conversationId' | 'rev'> {
  return {
    view: 'room',
    entry: {
      id: frame.entry.id,
      type: 'assistant',
      timestamp: frame.entry.timestamp,
      content: '',
      blocks: [],
    },
    tools: roomToolsOf(frame.entry),
    ...(frame.verdict ? { verdict: frame.verdict } : {}),
  };
}

/** Whether the asker was shown any prose a screen has not passed. */
function showedDraft(entry: AgentMessage | null): boolean {
  return (entry?.blocks ?? []).some((b) => b.type === 'text' && !!b.text);
}

/**
 * Watches one turn in one room, publishing its growing entry to the person it answers and only
 * that it works, and with which tools, to the room's other readers.
 */
export class ConversationProgress {
  readonly #acc: TranscriptAccumulator;
  #lastFlush = 0;
  #rev = 0;
  #closed = false;
  #verdict: ProgressVerdict | null = null;
  #asker: string | null = null;
  #lastRoom = '';
  #tail: Promise<unknown> = Promise.resolve();

  /** `entryId` is the one id the frames, the delivered message and the stored row all share. */
  constructor(
    private readonly conversationId: string,
    readonly entryId: string,
  ) {
    this.#acc = new TranscriptAccumulator(entryId);
  }

  /**
   * Name the person this turn acts as: only their sockets are shown its draft and its tool calls.
   * Until it is named, every reader is given the room's view.
   */
  askedBy(userId: string | null): void {
    this.#asker = userId;
  }

  /**
   * Tell the room's readers a turn is under way before it has produced anything, so a reader sees
   * it working within moments of sending rather than after the model's first round.
   */
  begin(): void {
    if (this.#acc.entry()) return;
    this.#send({
      entry: {
        id: this.entryId,
        type: 'assistant',
        timestamp: Date.now(),
        content: '',
        blocks: [],
      },
    });
  }

  /** A watcher for the rest of this turn, under its own entry and asker, already shown as working. */
  next(): ConversationProgress {
    const rest = new ConversationProgress(this.conversationId, randomUUID());
    rest.askedBy(this.#asker);
    rest.begin();
    return rest;
  }

  /** Fold one turn event in, and publish if the window or a tool boundary says to. */
  onTurnEvent = (event: ChatStreamEvent): void => {
    this.#acc.apply(event);
    const boundary = event.type === 'tool_call' || event.type === 'tool_result';
    if (!boundary && Date.now() - this.#lastFlush < ENTRY_FLUSH_MS) return;
    const entry = this.#acc.entry();
    if (!entry) return;
    this.#lastFlush = Date.now();
    this.#send({ entry });
  };

  /** The text the screen admitted, before it is delivered: the asker's draft gives way to it. */
  onSettled = ({ text, screenReplaced }: { text: string; screenReplaced: boolean }): void => {
    const entry = this.#acc.entry();
    const draft = (entry?.content ?? '').trim();
    const settled = text.trim();
    const checked: AgentMessage = {
      ...(entry ?? { id: this.entryId, type: 'assistant', timestamp: Date.now() }),
      content: settled,
      blocks: this.blocksForRecord(settled) ?? [{ type: 'text', text: settled }],
    };
    this.#verdict = 'checked';
    this.#send({
      entry: checked,
      verdict: 'checked',
      ...(screenReplaced && draft && draft !== settled ? { replaced: { draft } } : {}),
    });
  };

  /** The blocks to STORE beside a delivered reply, given the text that went out. */
  blocksForRecord = (finalText: string): ContentBlock[] | null => {
    const blocks = this.#acc.blocks();
    if (!blocks) return null;
    const draft = (this.#acc.entry()?.content ?? '').trim();
    if (draft === finalText.trim()) return blocks;
    const kept = blocks.filter((b) => b.type === 'tool' || b.type === 'thinking');
    if (kept.length === 0) return null;
    return [...kept, { type: 'text', text: finalText }];
  };

  /**
   * Stop watching, and wait for every frame already queued to be published. A turn that showed its
   * asker a draft and settled no reply takes the draft back first, so it is never left standing as
   * though it were the answer.
   */
  async close(): Promise<void> {
    const entry = this.#acc.entry();
    if (!this.#closed && this.#verdict === null && entry && showedDraft(entry)) {
      this.#verdict = 'withheld';
      this.#send({
        entry: {
          ...entry,
          content: '',
          blocks: (entry.blocks ?? []).filter((b) => b.type === 'tool' || b.type === 'thinking'),
        },
        verdict: 'withheld',
      });
    }
    this.#closed = true;
    await this.#tail;
  }

  #send(frame: AskerFrame): void {
    if (this.#closed) return;
    this.#rev += 1;
    const rev = this.#rev;
    const entry = freeze(frame.entry);
    const forAsker: ConversationProgressFrame = {
      conversationId: this.conversationId,
      rev,
      view: 'asker',
      entry,
      ...(frame.verdict ? { verdict: frame.verdict } : {}),
      ...(frame.replaced ? { replaced: frame.replaced } : {}),
    };
    const room = roomViewOf({ ...frame, entry });
    const roomKey = JSON.stringify(room);
    // a text flush changes nothing a reader who did not ask is shown; only the asker hears it
    const roomChanged = roomKey !== this.#lastRoom;
    this.#lastRoom = roomKey;
    const forRoom: ConversationProgressFrame | null = roomChanged
      ? { conversationId: this.conversationId, rev, ...room }
      : null;
    const asker = this.#asker;
    this.#tail = this.#tail
      .then(() =>
        publishEphemeralByViewer(this.conversationId, {
          event: WEB_CONVERSATION_PROGRESS_EVENT,
          askerUserId: asker,
          forAsker,
          forRoom,
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, conversationId: this.conversationId, rev },
          'conversations: a turn-progress frame was not published',
        );
      });
  }
}
