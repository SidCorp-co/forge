// The Assistant turn's side of BC-4 (REQ-30): a write the model calls is held, not made. Every call
// `turn-writes.ts:isWriteCall` marks — a record, a note, a preference, a comment, an attachment, an
// issue change — is refused CHAT_WRITE_AWAITS_AGREEMENT and kept as a proposal the person sees as a
// confirm card. A write the person's own role could not make is refused for that first, by the
// permission it lacks, as the tool itself would: a card offering it would only fail when pressed.
// `forge_agree` is how a later turn binds the person's reply to one of them; core
// checks the binding (`agree.ts`) and writes the held call as them.

import {
  CHAT_AGREE_TOOL,
  type ChatProposalKind,
  chatAgreeParamsSchema,
} from '@forge/contracts/chat-proposals';
import { z } from 'zod';
import type { TurnAuthority } from '../../credentials/turn-credential.js';
import { isRefusal } from '../../lib/refusal.js';
import type { CallToolResult } from '../../lib/tool-result.js';
import {
  actorFor,
  type ProjectPermission,
  projectResource,
  requireCan,
} from '../../permissions/index.js';
import { type ChatToolset, thrownMessage, toolError } from '../tools/mcp-adapter.js';
import { filingTitle, isWriteCall, titleKey } from '../turn-writes.js';
import type { TurnImage } from '../vision.js';
import { agreeProposal } from './agree.js';
import { type ChatProposalRow, pendingFor, recordProposal, restateProposal } from './store.js';
import { kindOfToolCall, summaryOfToolCall } from './summary.js';

/** The turn the gate holds writes for. */
export interface GatedTurn {
  projectId: string;
  conversationId: string;
  /** The person the turn answers: whose agreement a proposal waits on. */
  personId: string;
  handleUserId: string | null;
  /** The person's message, as the turn read it: a reply that agrees is quoted whole. */
  message: string;
  /** The person's authority, as the turn acts under it: an agreed write is made with it. */
  authority: TurnAuthority;
  /** The images the turn's record carries (a Feedback item, a comment), kept with what is held. */
  recordImages?: readonly TurnImage[] | undefined;
}

export interface AgreementGate {
  tools: ChatToolset;
  /** How many writes this turn held: its reply then waits on the person. */
  heldThisTurn(): number;
}

const LISTED_PENDING = 10;

/** What the person's role must hold for a held write to be offered; preferences are their own. */
const ROLE_NEEDED: Record<ChatProposalKind, ProjectPermission | null> = {
  feedback: 'project.write',
  requirement_draft: 'project.write',
  requirement_revision: 'project.write',
  comment: 'project.write',
  attachment: 'project.write',
  memory_note: 'project.write',
  preferences: null,
  report_save: 'project.write',
  issue_change: 'project.write',
};

/** The refusal of a write the person's role could not make, or null where it could. */
async function roleRefusal(
  turn: GatedTurn,
  kind: ChatProposalKind,
): Promise<CallToolResult | null> {
  const permission = ROLE_NEEDED[kind];
  if (!permission) return null;
  try {
    await requireCan(actorFor(turn.personId), permission, projectResource(turn.projectId));
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
};

function heldText(row: ChatProposalRow, tool: string): string {
  return [
    `CHAT_WRITE_AWAITS_AGREEMENT: nothing was written. Core holds this ${KIND_WORDS[row.kind]} as proposal ${row.id} (kind ${row.kind}) until the person agrees; they see it in this conversation as a confirm card they can record or decline.`,
    'End this reply by restating what it records, where, and what it relates to, with any question only they can answer, and ask for their go-ahead. Do not say it is recorded.',
    `When they agree in a later message, call ${CHAT_AGREE_TOOL} with proposal ${row.id}, kind ${row.kind} and their whole message as words; do not call ${tool} again for it.`,
  ].join(' ');
}

function agreeDescription(pending: readonly ChatProposalRow[]): string {
  const listed = pending
    .slice(-LISTED_PENDING)
    .map((p) => `${p.id} (${p.kind}): ${(p.summary as { title?: string }).title ?? ''}`)
    .join('; ');
  return [
    'Write a record the person agreed to by replying: a proposal core held earlier in this conversation, made to them.',
    'Call it only when their message agrees to that proposal; pass its id, its kind and their WHOLE message as words, quoted as they wrote it.',
    'Core checks all three and writes exactly what was proposed, as them; a reply that does not agree writes nothing, so do not call it then.',
    `Waiting on this person: ${listed}.`,
  ].join(' ');
}

function agreeTool(pending: readonly ChatProposalRow[]) {
  return {
    type: 'function' as const,
    function: {
      name: CHAT_AGREE_TOOL,
      description: agreeDescription(pending),
      parameters: z.toJSONSchema(chatAgreeParamsSchema, { io: 'input' }) as Record<string, unknown>,
    },
  };
}

async function agreeByReply(turn: GatedTurn, startedAt: Date, argsJson: string) {
  let raw: unknown;
  try {
    raw = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return toolError(`${CHAT_AGREE_TOOL}: the arguments were not valid JSON; nothing was written`);
  }
  const params = chatAgreeParamsSchema.safeParse(raw);
  if (!params.success) {
    const where = params.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return toolError(`${CHAT_AGREE_TOOL}: ${where}; nothing was written`);
  }
  const { proposal, kind, words } = params.data;
  try {
    const { row, outcome } = await agreeProposal(proposal, {
      via: 'reply',
      userId: turn.personId,
      authority: turn.authority,
      reply: { conversationId: turn.conversationId, message: turn.message, startedAt, words, kind },
    });
    if (!outcome.ok) {
      return toolError(
        `The person agreed, and the write was refused, so nothing was recorded: ${outcome.failure} Tell them so.`,
      );
    }
    const text = JSON.stringify({
      recorded: { proposal: row.id, kind: row.kind, ref: outcome.record.ref },
      answered: outcome.answered,
      note: 'Written as the person agreed. Name the record it made, read from what it answered.',
    });
    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    if (isRefusal(err)) return toolError(`${err.message} Nothing was written.`);
    throw err;
  }
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
export async function agreementGate(inner: ChatToolset, turn: GatedTurn): Promise<AgreementGate> {
  const startedAt = new Date();
  const pending = await pendingFor(turn.conversationId, turn.personId, startedAt);
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
    tools: [...inner.tools, ...(pending.length > 0 ? [agreeTool(pending)] : [])],
    async execute(name, argsJson) {
      if (name === CHAT_AGREE_TOOL) return agreeByReply(turn, startedAt, argsJson);
      if (isWriteCall(name, argsJson)) return hold(name, argsJson);
      return inner.execute(name, argsJson);
    },
    ranAs: (name) => (name === CHAT_AGREE_TOOL ? turn.personId : inner.ranAs(name)),
  };
  return { tools, heldThisTurn: () => heldNow.size };
}
