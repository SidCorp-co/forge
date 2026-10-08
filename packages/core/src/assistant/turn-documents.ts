/**
 * Which of a window's attached documents the model reads this turn, and how much of each. A
 * document is the person's input — a spec, an audit, meeting notes — so unlike a picture it stays in
 * view for as long as its message is in the window: a requirement is discussed over many turns about
 * one file. What bounds it is a token budget, filled newest first, and every cut is said in the
 * block the model reads, so it never answers about the part it was not shown as if it had read it.
 */

import { CONVERSATION_DOCUMENT_MIMES } from '@forge/contracts/attachments';
import type { ConversationImage, RoomDocument } from '../conversations/index.js';

/**
 * The tokens every attached document together may take of a turn's request, estimated as
 * `context-budget.ts` estimates (chars/4). A third of the 80k default context budget: the transcript,
 * the tool catalog and the tool rounds keep the rest.
 */
export const DOCUMENT_BUDGET_TOKENS = 24_000;

const CHARS_PER_TOKEN = 4;

export type DocumentResolver = (document: ConversationImage) => Promise<RoomDocument>;

export function isDocumentAttachment(file: ConversationImage): boolean {
  return CONVERSATION_DOCUMENT_MIMES.includes(file.mime);
}

function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const number = (n: number) => n.toLocaleString('en-US');

function header(file: ConversationImage, redacted: boolean): string {
  const said = redacted
    ? ' Secret-shaped values in it were redacted before you were shown it.'
    : '';
  return `[Attached document: ${file.name} (${file.mime}). It is the person's input: cite it by its file name.${said}]`;
}

/** The block a document is shown as: whole, cut with the cut said, or not shown and why. */
export function documentBlock(
  file: ConversationImage,
  read: RoomDocument,
  budgetTokens: number,
): { block: string; tokens: number } {
  if (!read.ok) {
    return {
      block: `[Attached document: ${file.name} (${file.mime}) could not be read this turn: ${read.reason}. Say so; never answer as if you had read it.]`,
      tokens: 0,
    };
  }
  const total = tokensOf(read.text.length);
  if (budgetTokens <= 0) {
    return {
      block: `[Attached document: ${file.name} (${file.mime}), ~${number(total)} tokens, is not shown this turn: the documents attached after it filled the ~${number(DOCUMENT_BUDGET_TOKENS)}-token budget for documents. Say you cannot see it now if asked about it.]`,
      tokens: 0,
    };
  }
  const open = `${header(file, read.redacted)}\n<document name="${file.name}">\n`;
  const close = '\n</document>';
  if (total <= budgetTokens) {
    return { block: `${open}${read.text}${close}`, tokens: total };
  }
  const shownChars = budgetTokens * CHARS_PER_TOKEN;
  const cutAt = read.text.lastIndexOf('\n', shownChars);
  const shown = read.text.slice(0, cutAt > shownChars / 2 ? cutAt : shownChars);
  const shownLines = shown.split('\n').length;
  const totalLines = read.text.split('\n').length;
  const cut = `[${file.name} is cut here: you were shown the first ~${number(tokensOf(shown.length))} of its ~${number(total)} tokens (lines 1–${number(shownLines)} of ${number(totalLines)}). Tell the person what you read stops at line ${number(shownLines)}, and never answer about the rest as if you had read it.]`;
  return { block: `${open}${shown}${close}\n${cut}`, tokens: tokensOf(shown.length) };
}

/** Just enough of a stored turn to find its documents. */
interface DocumentBearingMessage {
  images?: readonly ConversationImage[] | undefined;
}

/**
 * The `ref → block` map `toProviderMessages` renders documents from, filled newest first under one
 * budget. A document attached twice is shown once, at its newest message.
 */
export async function resolveTurnDocuments(
  messages: readonly DocumentBearingMessage[],
  resolve: DocumentResolver | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!resolve) return out;
  let budget = DOCUMENT_BUDGET_TOKENS;
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const file of messages[i]?.images ?? []) {
      if (!isDocumentAttachment(file) || out.has(file.ref)) continue;
      const { block, tokens } = documentBlock(file, await resolve(file), budget);
      budget -= tokens;
      out.set(file.ref, block);
    }
  }
  return out;
}
