// The Assistant turn's side of BC-4 (REQ-30): a write the model calls is held, not made. Every call
// meets the one chat write rule (`write-rule.ts`) the REST and /mcp doors read too: a write it
// holds — a record, a note, a preference, a comment, an attachment, an issue or project change, a
// report save — is refused CHAT_WRITE_AWAITS_AGREEMENT and kept as a proposal the person sees as a
// confirm card; a write it refuses is refused CHAT_WRITE_REFUSED by name, writing nothing; only a
// read, or a call the rule names as not a business write, reaches the tool. A write the person's
// own role could not make is refused for that first, by the permission it lacks, as the tool itself
// would: a card offering it would only fail when pressed. Only the person's press on the card writes
// a held call (`agree.ts`): the turn has no tool that agrees, so nothing the person types, and
// nothing the model makes of it, writes one.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { isRefusal } from '../../lib/refusal.js';
import type { CallToolResult } from '../../lib/tool-result.js';
import { type ChatToolset, thrownMessage, toolError } from '../tools/mcp-adapter.js';
import { withinPersistLimits } from '../tools/turn-images.js';
import { filingTitle, titleKey } from '../turn-writes.js';
import type { TurnImage } from '../vision.js';
import { splitPlain, withPlainParam } from './plain-arg.js';
import { refusedTwice, targetOf } from './refused-twice.js';
import { requireRoleFor } from './roles.js';
import { type ChatProposalRow, recordProposal, restateProposal } from './store.js';
import { imagesLine, summaryOfToolCall } from './summary.js';
import { vetHeld } from './vet.js';
import { decideToolCall, refusedWriteText } from './write-rule.js';

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

function heldText(row: ChatProposalRow, tool: string, plain: string | null): string {
  return [
    `CHAT_WRITE_AWAITS_AGREEMENT: nothing was written yet. Core holds this ${KIND_WORDS[row.kind]} as proposal ${row.id} (kind ${row.kind}) until the person agrees to it in this conversation; no tool of yours agrees for them.`,
    `To change what it proposes, call ${tool} again with the change.`,
    ...(plain
      ? []
      : [
          `Its card shows that you wrote no \`plain\` line, the line the person decides it from: call ${tool} again with \`plain\`.`,
        ]),
  ].join(' ');
}

const imagesOf = (turn: GatedTurn) =>
  (turn.recordImages ?? []).map((i) => ({
    name: i.name,
    mime: i.mime,
    ref: i.ref,
    dataBase64: i.dataBase64,
  }));

/** The images the press attaches: every one to a Feedback item, those within a comment's caps to a comment. */
function attachedOnPress(turn: GatedTurn, kind: ChatProposalKind): string[] {
  const images = turn.recordImages ?? [];
  const kept = kind === 'comment' ? withinPersistLimits(images).kept : images;
  return kept.map((i) => i.name);
}

/**
 * Wrap the turn's toolset so it holds every write. A second call naming what this turn already
 * held (the same tool and title, or the same arguments) restates that proposal rather than making
 * another, since a retry asks again for the record the first attempt proposed.
 */
export function agreementGate(inner: ChatToolset, turn: GatedTurn): AgreementGate {
  // keyed before the insert is awaited, so two calls of one round hold one proposal between them
  const heldNow = new Map<string, Promise<ChatProposalRow>>();
  // one answer per act and target a turn, so a model retrying a refused offer files the defect once
  const twiceNow = new Map<string, Promise<CallToolResult | null>>();
  const hold = async (
    name: string,
    argsJson: string,
    kind: ChatProposalKind,
    plain: string | null,
  ): Promise<CallToolResult> => {
    const refused = await roleRefusal(turn, kind);
    if (refused) return refused;
    const unfit = await vetHeld(name, argsJson, turn.projectId);
    if (unfit) return unfit;
    const target = targetOf(kind, argsJson);
    const twiceKey = `${kind}\u0000${target}`;
    const twice =
      twiceNow.get(twiceKey) ??
      refusedTwice({
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        personId: turn.personId,
        kind,
        kindWords: KIND_WORDS[kind],
        target,
      });
    twiceNow.set(twiceKey, twice);
    const again = await twice;
    if (again) return again;
    const images = imagesOf(turn);
    const shown = summaryOfToolCall(kind, name, argsJson);
    const attaching = imagesLine(kind, name, argsJson, attachedOnPress(turn, kind));
    const summary = {
      ...(attaching ? { ...shown, lines: [...shown.lines, attaching] } : shown),
      plain,
    };
    const title = filingTitle(name, argsJson);
    const key = `${name}\u0000${title ? titleKey(title) : argsJson}`;
    const call = { name, arguments: argsJson, ...(images.length > 0 ? { images } : {}) };
    const earlier = heldNow.get(key);
    if (earlier) {
      const row = await earlier;
      await restateProposal(row.id, call, summary);
      return toolError(heldText(row, name, plain));
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
    return toolError(heldText(await recording, name, plain));
  };
  const tools: ChatToolset = {
    tools: withPlainParam(inner.tools),
    async execute(name, sent) {
      // the card's plain line is never part of the write: the rule, the card and the tool read the call without it
      const { argsJson, plain } = splitPlain(name, sent);
      const verdict = decideToolCall(name, argsJson, inner.grantOf?.(name, argsJson) ?? null);
      if (verdict.verdict === 'hold') return hold(name, argsJson, verdict.kind, plain);
      if (verdict.verdict === 'refuse') {
        return toolError(`CHAT_WRITE_REFUSED: ${refusedWriteText(verdict, name)}`);
      }
      return inner.execute(name, argsJson);
    },
    ranAs: (name) => inner.ranAs(name),
    grantOf: (name, sent) => {
      const { argsJson } = splitPlain(name, sent);
      return inner.grantOf?.(name, argsJson) ?? null;
    },
  };
  return { tools, heldThisTurn: () => heldNow.size };
}
