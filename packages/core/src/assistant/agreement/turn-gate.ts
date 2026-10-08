// The Assistant turn's side of BC-4 (REQ-30): a write the model calls is held, not made. Every call
// `turn-writes.ts:isWriteCall` marks — a record, a note, a preference, a comment, an attachment, an
// issue or project change, a report save — is refused CHAT_WRITE_AWAITS_AGREEMENT and kept as a
// proposal the person sees as a confirm card. A write the person's own role could not make is
// refused for that first, by the permission it lacks, as the tool itself would: a card offering it
// would only fail when pressed. Only the person's press on the card writes it (`agree.ts`): the
// turn has no tool that agrees, so nothing the person types, and nothing the model makes of it,
// writes a held call.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { isRefusal } from '../../lib/refusal.js';
import type { CallToolResult } from '../../lib/tool-result.js';
import { type ChatToolset, thrownMessage, toolError } from '../tools/mcp-adapter.js';
import { filingTitle, isWriteCall, titleKey } from '../turn-writes.js';
import type { TurnImage } from '../vision.js';
import { requireRoleFor } from './roles.js';
import { type ChatProposalRow, recordProposal, restateProposal } from './store.js';
import { kindOfToolCall, summaryOfToolCall } from './summary.js';

/** The turn the gate holds writes for. */
export interface GatedTurn {
  projectId: string;
  conversationId: string;
  /** The person the turn answers: whose agreement a proposal waits on. */
  personId: string;
  handleUserId: string | null;
  /** The images the turn's record carries (a Feedback item, a comment), kept with what is held. */
  recordImages?: readonly TurnImage[] | undefined;
}

export interface AgreementGate {
  tools: ChatToolset;
  /** How many writes this turn held: its reply then waits on the person. */
  heldThisTurn(): number;
}

/** The refusal of a write the person's role could not make, or null where it could. */
async function roleRefusal(
  turn: GatedTurn,
  kind: ChatProposalKind,
): Promise<CallToolResult | null> {
  try {
    await requireRoleFor(kind, turn.personId, turn.projectId);
    return null;
  } catch (err) {
    if (!isRefusal(err)) throw err;
    return toolError(thrownMessage(err));
  }
}

const KIND_WORDS: Record<ChatProposalKind, string> = {
  feedback: 'Feedback item',
  requirement_draft: 'draft Requirement',
  requirement_revision: 'draft revision',
  comment: 'comment',
  attachment: 'attachment',
  memory_note: 'memory note',
  preferences: 'change to their reply preferences',
  report_save: 'saved report',
  issue_change: 'change to an issue',
  requirement_link: "change to a requirement's links",
  project_change: 'change to the project',
};

function heldText(row: ChatProposalRow, tool: string): string {
  return [
    `CHAT_WRITE_AWAITS_AGREEMENT: nothing was written. Core holds this ${KIND_WORDS[row.kind]} as proposal ${row.id} (kind ${row.kind}) until the person agrees; they see it in this conversation as a confirm card, with Record it and Decline.`,
    'End this reply by restating what it records, where, and what it relates to, with any question only they can answer, and ask them to press Record it on the card when it is right. Do not say it is recorded.',
    `Only their press records it: a reply they type, yes or no, writes nothing, and no tool of yours agrees for them. If they say yes in words, tell them to press Record it on the card; if they want it changed, call ${tool} again with the change, which restates the card.`,
  ].join(' ');
}

const imagesOf = (turn: GatedTurn) =>
  (turn.recordImages ?? []).map((i) => ({
    name: i.name,
    mime: i.mime,
    ref: i.ref,
    dataBase64: i.dataBase64,
  }));

/**
 * Wrap the turn's toolset so it holds every write. A second call naming what this turn already
 * held (the same tool and title, or the same arguments) restates that proposal rather than making
 * another, since a retry asks again for the record the first attempt proposed.
 */
export function agreementGate(inner: ChatToolset, turn: GatedTurn): AgreementGate {
  // keyed before the insert is awaited, so two calls of one round hold one proposal between them
  const heldNow = new Map<string, Promise<ChatProposalRow>>();
  const hold = async (name: string, argsJson: string): Promise<CallToolResult> => {
    const kind = kindOfToolCall(name, argsJson);
    const refused = await roleRefusal(turn, kind);
    if (refused) return refused;
    const summary = summaryOfToolCall(kind, name, argsJson);
    const title = filingTitle(name, argsJson);
    const key = `${name}\u0000${title ? titleKey(title) : argsJson}`;
    const images = imagesOf(turn);
    const call = { name, arguments: argsJson, ...(images.length > 0 ? { images } : {}) };
    const earlier = heldNow.get(key);
    if (earlier) {
      const row = await earlier;
      await restateProposal(row.id, call, summary);
      return toolError(heldText(row, name));
    }
    const recording = recordProposal({
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      proposedTo: turn.personId,
      handleUserId: turn.handleUserId,
      sessionId: null,
      kind,
      form: 'tool',
      call,
      body: null,
      summary,
    });
    heldNow.set(key, recording);
    return toolError(heldText(await recording, name));
  };
  const tools: ChatToolset = {
    tools: inner.tools,
    async execute(name, argsJson) {
      if (isWriteCall(name, argsJson)) return hold(name, argsJson);
      return inner.execute(name, argsJson);
    },
    ranAs: (name) => inner.ranAs(name),
  };
  return { tools, heldThisTurn: () => heldNow.size };
}
