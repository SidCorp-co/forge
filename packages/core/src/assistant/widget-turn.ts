/**
 * One turn of the feedback widget's assistant: a client site's visitor, never a Forge user, talks
 * to an assistant that reads nothing of the project.
 *
 * It runs on the shared turn loop (`runTurnEvents`) and its reply passes the shared screen and its
 * repair (`screenedTurnReply`, door `widget-chat-reply`), but it does not go through the project
 * turn (`runExternalChatTurn`): that one puts the project's progress and the handle's self in the
 * prompt, and acts as a Forge person whose credential bounds its tools. Here there is no person to
 * act as and nothing to read, so nothing is minted: the prompt is the widget door's layer, the
 * binding's title and greeting, the visitor's words and the page they are on, every word of the
 * visitor's marked as untrusted data; the one tool proposes a draft through the caller's `propose`.
 */

import type { ReplyLanguage, ScreenedMessage } from '../conversations/index.js';
import { CORRECTIVE_PREFIX } from '../conversations/index.js';
import { type ChatMessage, type ChatStreamEvent, openChat } from '../integrations/llm/index.js';
import { dataPolicyOf, EgressRefused, egressAt } from '../lib/data-egress.js';
import { env } from '../lib/env.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { widgetDoorPersona } from './door-persona.js';
import type { ExternalChatTurnResult } from './external-chat.js';
import { runTurnEvents } from './run-turn-core.js';
import { screenedTurnReply } from './screened-reply.js';
import {
  buildWidgetDraftToolset,
  WIDGET_DRAFT_TOOL,
  type WidgetDraftParams,
} from './tools/widget-draft-tool.js';

/** How many lines of the conversation a widget turn reads back. */
const WIDGET_HISTORY_WINDOW = 30;

/** The source label every visitor line carries inside its untrusted frame. */
export const WIDGET_VISITOR_SOURCE = 'widget visitor';
const WIDGET_PAGE_SOURCE = 'widget host page';
const WIDGET_DRAFT_SOURCE = 'widget pending draft';

export interface WidgetTurnLine {
  role: 'visitor' | 'assistant';
  text: string;
}

export interface WidgetTurnArgs {
  projectId: string;
  conversationId: string;
  site: { title: string; greeting: string | null };
  /** The conversation so far, oldest first, ending with what the visitor just said. */
  lines: readonly WidgetTurnLine[];
  /** The page the visitor is on, as the host page reported it. */
  pageContext: Record<string, unknown> | null;
  /** The draft waiting on the visitor, where one is. */
  pending: WidgetDraftParams | null;
  /** Store a proposed draft and answer its id. */
  propose: (draft: WidgetDraftParams) => Promise<{ draftId: string }>;
  language: ReplyLanguage;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: ChatStreamEvent) => void) | undefined;
}

export interface WidgetTurnResult {
  /** The reply as the screen admitted it, or the code-authored line standing in for it. */
  message: ScreenedMessage | null;
  /** The tools the model was offered: the widget's one, and nothing else. */
  offered: readonly string[];
  /** What the model was sent, system prompt first, for the record of what it could read. */
  sent: readonly ChatMessage[];
  terminal: 'done' | 'error';
  error: string | null;
}

/** The prompt and the conversation as the model reads them, the visitor's every word framed as data. */
export function widgetTurnMessages(
  args: Pick<WidgetTurnArgs, 'site' | 'lines' | 'pageContext' | 'pending'>,
): ChatMessage[] {
  const context: string[] = [];
  if (args.pageContext && Object.keys(args.pageContext).length > 0) {
    context.push(
      `The page the visitor is on, as their browser reported it:\n${markUntrusted(JSON.stringify(args.pageContext), { source: WIDGET_PAGE_SOURCE })}`,
    );
  }
  if (args.pending) {
    context.push(
      `The draft waiting on the visitor (a new proposal replaces it):\n${markUntrusted(JSON.stringify(args.pending), { source: WIDGET_DRAFT_SOURCE })}`,
    );
  }
  const system = [widgetDoorPersona(args.site), ...context].join('\n\n');
  return [
    { role: 'system', content: system },
    ...args.lines
      .slice(-WIDGET_HISTORY_WINDOW)
      .map(
        (line): ChatMessage =>
          line.role === 'visitor'
            ? { role: 'user', content: markUntrusted(line.text, { source: WIDGET_VISITOR_SOURCE }) }
            : { role: 'assistant', content: line.text },
      ),
  ];
}

export async function runWidgetTurn(args: WidgetTurnArgs): Promise<WidgetTurnResult> {
  const what = `widget conversation ${args.conversationId}`;
  const level = await dataPolicyOf(args.projectId);
  const egressed = egressAt(level, 'conversation', widgetTurnMessages(args), what);
  if (!egressed.ok) throw new EgressRefused(egressed.refusal);
  const messages = egressed.value;
  const tools = buildWidgetDraftToolset(args.propose);
  const offered = tools.tools.map((t) => t.function.name);
  const resolved = await openChat({ surface: 'conversation', projectId: args.projectId, what });

  const attempt = async (extra: readonly ChatMessage[]): Promise<ExternalChatTurnResult> => {
    const gen = runTurnEvents({
      provider: resolved.provider,
      model: resolved.model,
      messages: [...messages, ...extra],
      tools,
      temperature: 0.2,
      requireInitialToolUse: false,
      contextBudgetTokens: env.CHAT_CONTEXT_BUDGET_TOKENS,
      signal: args.signal,
    });
    let step = await gen.next();
    while (!step.done) {
      args.onEvent?.(step.value);
      step = await gen.next();
    }
    const result = step.value;
    return {
      conversationId: args.conversationId,
      reply: result.finalText,
      terminal: result.terminal,
      error: result.errorMessage,
      errorSource: result.errorSource,
      partial: result.partialText,
      rounds: result.rounds,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      progress: null,
    };
  };

  const first = await attempt([]);
  const lastSaid = [...args.lines].reverse().find((l) => l.role === 'visitor')?.text;
  const message = await screenedTurnReply({
    door: 'widget-chat-reply',
    projectId: args.projectId,
    conversationId: args.conversationId,
    handleName: args.site.title,
    language: args.language,
    first,
    offeredTools: offered,
    // a rewrite reads its first attempt's rounds, so the draft it proposed is not proposed again
    retry: (instruction) =>
      attempt([
        ...(first.rounds ?? []),
        { role: 'user', content: `${CORRECTIVE_PREFIX} ${instruction}` },
      ]),
    setPhase: () => undefined,
    fallback: 'code-authored',
    askedIn: args.language,
    ...(lastSaid !== undefined ? { question: lastSaid } : {}),
    log: { door: 'widget-chat-reply', conversationId: args.conversationId },
  });
  return { message, offered, sent: messages, terminal: first.terminal, error: first.error };
}

export { WIDGET_DRAFT_TOOL };
