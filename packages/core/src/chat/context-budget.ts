/**
 * Bounds the message array before every provider call. History was windowed by COUNT and each tool
 * result capped at 24k chars, but nothing summed them: seven tool rounds could push ~170k chars of
 * `role:'tool'` content into a window nothing measured, and the turn 400'd on context length as a
 * generic `error`. This estimates (chars/4, no tokenizer) and elides — oldest history first, then
 * the oldest intra-turn tool results — and tells the model what it can no longer see.
 */

import type { ChatContentPart, ChatMessage } from './providers/types.js';

export const PROVIDER_HISTORY_WINDOW = 30;

// cm:guard 80k ESTIMATED tokens, not the model's window: `LITELLM_MODEL` defaults to gpt-4o-mini (128k) and chars/4 under-counts JSON and tool output (closer to 3 chars/token), so 80k estimated is ~107k real in the worst case and still leaves room for the answer; a 1M-context deployment raises CHAT_CONTEXT_BUDGET_TOKENS in env rather than this constant
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 80_000;

// cm:guard an `image_url` part is a `data:` URI — ~1.4M chars for a 1 MB screenshot — and chars/4 would bill it as 350k tokens and gut the transcript to make room for a picture the model bills at about a thousand, so image parts cost a flat estimate
export const IMAGE_PART_TOKENS = 1_000;

export interface ElisionReport {
  /** History messages dropped, oldest first. */
  historyMessages: number;
  /** Intra-turn tool results whose content was replaced by a marker. */
  truncatedToolResults: number;
  /** The pinned messages (system + newest user turn) plus the tool schemas alone exceed the budget: nothing was dropped and the provider will most likely reject the request. */
  overBudget: boolean;
}

export function emptyElision(): ElisionReport {
  return { historyMessages: 0, truncatedToolResults: 0, overBudget: false };
}

export function addElision(into: ElisionReport, from: ElisionReport): void {
  into.historyMessages += from.historyMessages;
  into.truncatedToolResults += from.truncatedToolResults;
  into.overBudget = into.overBudget || from.overBudget;
}

const OMITTED_MARKER = /^\[(\d+) earlier messages omitted for length\]\n\n/;

function omittedMarker(n: number): string {
  return `[${n} earlier messages omitted for length]\n\n`;
}

function elidedToolResult(removedChars: number): string {
  return `[tool result elided: ${removedChars} chars removed to fit the context budget; call the tool again if you still need it]`;
}

function estimateText(s: string): number {
  return Math.ceil(s.length / 4);
}

/** chars/4 over everything the wire carries for the message, image parts flat. */
export function estimateMessageTokens(m: ChatMessage): number {
  let n = 4;
  if (typeof m.content === 'string') n += estimateText(m.content);
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      n += part.type === 'text' ? estimateText(part.text) : IMAGE_PART_TOKENS;
    }
  }
  if (m.tool_calls) n += estimateText(JSON.stringify(m.tool_calls));
  if (m.tool_call_id) n += estimateText(m.tool_call_id);
  return n;
}

/** Split history into atomic units: an assistant message carrying `tool_calls` travels with the `tool` replies that follow it. */
function toUnits(history: readonly ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  for (const m of history) {
    const last = units[units.length - 1];
    if (m.role === 'tool' && last?.[0]?.tool_calls) last.push(m);
    else units.push([m]);
  }
  return units;
}

function prefixText(m: ChatMessage, prefix: string): ChatMessage {
  if (typeof m.content === 'string') {
    return { ...m, content: prefix + m.content.replace(OMITTED_MARKER, '') };
  }
  if (Array.isArray(m.content)) {
    const parts: ChatContentPart[] = m.content.map((p) =>
      p.type === 'text' ? { ...p, text: p.text.replace(OMITTED_MARKER, '') } : p,
    );
    return { ...m, content: [{ type: 'text', text: prefix.trimEnd() }, ...parts] };
  }
  return { ...m, content: prefix.trimEnd() };
}

function readOmitted(m: ChatMessage | undefined): number {
  if (!m) return 0;
  const text =
    typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? (m.content.find((p) => p.type === 'text')?.text ?? '')
        : '';
  const hit = OMITTED_MARKER.exec(text);
  return hit ? Number(hit[1]) : 0;
}

export interface ContextBudgetOptions {
  budgetTokens: number;
  /** Estimated tokens the tool schemas add to the request this round. */
  reservedTokens: number;
}

/**
 * Pins `messages[0]` when it is the system message and the LAST `role:'user'` message (the newest
 * turn — intra-turn messages are only assistant/tool, so it is unambiguous), drops the oldest
 * history units until the estimate fits, then truncates the oldest intra-turn tool results in place
 * of dropping them. Returns new arrays and message objects; the input is never mutated.
 */
// cm:guard never drop or reorder an assistant `tool_calls` message or a `role:'tool'` reply on its own — the pair is atomic on the wire (a `tool` message whose `tool_call_id` has no parent is a provider 400, not a degraded answer), which is why history goes in units and intra-turn results are truncated rather than removed
export function applyContextBudget(
  messages: readonly ChatMessage[],
  opts: ContextBudgetOptions,
): { messages: ChatMessage[]; elided: ElisionReport } {
  const elided = emptyElision();
  const newestUser = messages.map((m) => m.role).lastIndexOf('user');
  if (newestUser === -1) return { messages: [...messages], elided };

  const hasSystem = messages[0]?.role === 'system' && newestUser > 0;
  const system = hasSystem ? (messages[0] as ChatMessage) : null;
  const units = toUnits(messages.slice(hasSystem ? 1 : 0, newestUser));
  const intra = messages.slice(newestUser + 1).map((m) => ({ ...m }));
  const newest = messages[newestUser] as ChatMessage;

  const fixed =
    (system ? estimateMessageTokens(system) : 0) +
    estimateMessageTokens(newest) +
    opts.reservedTokens;
  let total =
    fixed +
    units.reduce((n, u) => n + u.reduce((k, m) => k + estimateMessageTokens(m), 0), 0) +
    intra.reduce((n, m) => n + estimateMessageTokens(m), 0);

  if (fixed > opts.budgetTokens) {
    elided.overBudget = true;
    return { messages: [...messages], elided };
  }

  const alreadyOmitted = readOmitted(units.flat().find((m) => m.role === 'user') ?? newest);
  while (total > opts.budgetTokens && units.length > 0) {
    const unit = units.shift() as ChatMessage[];
    total -= unit.reduce((k, m) => k + estimateMessageTokens(m), 0);
    elided.historyMessages += unit.length;
  }

  for (const m of intra) {
    if (total <= opts.budgetTokens) break;
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const marker = elidedToolResult(m.content.length);
    if (m.content.length <= marker.length) continue;
    total -= estimateText(m.content) - estimateText(marker);
    m.content = marker;
    elided.truncatedToolResults += 1;
  }
  if (total > opts.budgetTokens) elided.overBudget = true;

  const kept: ChatMessage[] = [...units.flat(), newest];
  const omitted = alreadyOmitted + elided.historyMessages;
  if (omitted > 0) {
    const first = kept.findIndex((m) => m.role === 'user');
    kept[first] = prefixText(kept[first] as ChatMessage, omittedMarker(omitted));
  }
  return { messages: [...(system ? [system] : []), ...kept, ...intra], elided };
}
