import type { AIProvider, Message, StreamEvent, TokenUsage, ToolDefinition } from './provider';
import type { ForgeTool, ForgeToolContext } from './tools';
import { buildContextMessages } from './context';
import { logToolCall } from '../audit';

function safeParseJson(json: string): Record<string, unknown> {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

const MAX_ITERATIONS = 20;
const MAX_CONTEXT_TOKENS = 128_000;
const RESERVE_FOR_RESPONSE = 8192;

export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface IterationLog {
  iter: number;
  ctxMessages: number;
  ctxChars: number;
  stopReason: string;
  textChars: number;
  tools: string[];
  toolResultChars: number[];
}

export interface AgentRunResult {
  text: string;
  messages: Message[];
  usage: TokenUsage;
  iterations: number;
  toolCalls: ToolCallRecord[];
  aborted: boolean;
  error?: string;
  iterationLogs?: IterationLog[];
}

export interface AgentRunParams {
  provider: AIProvider;
  model: string;
  messages: Message[];
  tools: ForgeTool[];
  toolDefinitions: ToolDefinition[];
  systemPrompt: string;
  toolContext: ForgeToolContext;
  signal: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  maxIterations?: number;
}

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const {
    provider,
    model,
    tools,
    toolDefinitions,
    systemPrompt,
    toolContext,
    signal,
    onEvent,
  } = params;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  let messages = [...params.messages];
  const allToolCalls: ToolCallRecord[] = [];
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let finalText = '';
  let iterations = 0;
  let aborted = false;
  const log = toolContext.strapi.log;
  const iterationLogs: IterationLog[] = [];

  try {
    const maxIter = params.maxIterations ?? MAX_ITERATIONS;
    for (iterations = 0; iterations < maxIter; iterations++) {
      if (signal.aborted) {
        aborted = true;
        break;
      }

      const contextMessages = buildContextMessages({
        systemPrompt,
        history: messages.slice(0, -1),
        newMessage: messages[messages.length - 1],
        maxTokens: MAX_CONTEXT_TOKENS,
        reserveForResponse: RESERVE_FOR_RESPONSE,
      });

      const ctxChars = contextMessages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);

      let iterText = '';
      let stopReason = '';
      const pendingToolCalls: Array<{ id: string; name: string; inputJson: string }> = [];

      const stream = provider.stream({
        model,
        messages: contextMessages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        systemPrompt,
        maxTokens: RESERVE_FOR_RESPONSE,
        signal,
      });

      for await (const event of stream) {
        onEvent?.(event);

        switch (event.type) {
          case 'text_delta':
            iterText += event.text;
            break;
          case 'tool_use_start':
            pendingToolCalls.push({ id: event.id, name: event.name, inputJson: '' });
            break;
          case 'tool_use_delta': {
            const tc = pendingToolCalls.find((t) => t.id === event.id);
            if (tc) tc.inputJson += event.partialInput;
            break;
          }
          case 'tool_use_end': {
            const tc = pendingToolCalls.find((t) => t.id === event.id);
            if (tc) tc.inputJson = JSON.stringify(event.input);
            break;
          }
          case 'message_end':
            totalUsage.inputTokens += event.usage.inputTokens;
            totalUsage.outputTokens += event.usage.outputTokens;
            if (event.usage.cacheReadTokens) totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + event.usage.cacheReadTokens;
            if (event.usage.cacheWriteTokens) totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + event.usage.cacheWriteTokens;
            stopReason = event.stopReason;
            break;
          case 'error':
            throw new Error(event.error);
        }
      }

      // Build assistant message
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      > = [];

      if (iterText) {
        assistantContent.push({ type: 'text', text: iterText });
        finalText += iterText;
      }

      for (const tc of pendingToolCalls) {
        const input = safeParseJson(tc.inputJson);
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }

      messages.push({ role: 'assistant', content: assistantContent });

      if (stopReason === 'end_turn' || stopReason === 'stop' || pendingToolCalls.length === 0) {
        iterationLogs.push({
          iter: iterations, ctxMessages: contextMessages.length, ctxChars,
          stopReason, textChars: iterText.length,
          tools: pendingToolCalls.map((t) => t.name), toolResultChars: [],
        });
        break;
      }

      // Execute tool calls
      const toolResults: Array<{
        type: 'tool_result';
        toolUseId: string;
        content: string;
        isError?: boolean;
      }> = [];

      for (const tc of pendingToolCalls) {
        const tool = toolMap.get(tc.name);
        const input = safeParseJson(tc.inputJson);

        const start = Date.now();
        let result: string;
        let isError = false;

        if (!tool) {
          result = `Unknown tool: ${tc.name}`;
          isError = true;
        } else {
          try {
            result = await tool.execute(input, toolContext);
          } catch (err: unknown) {
            result = err instanceof Error ? err.message : String(err);
            isError = true;
          }
        }

        const durationMs = Date.now() - start;
        allToolCalls.push({ id: tc.id, name: tc.name, input, result, isError, durationMs });
        toolResults.push({ type: 'tool_result', toolUseId: tc.id, content: result, isError });

        logToolCall(toolContext.strapi, {
          toolName: tc.name, toolInput: input, toolResult: result,
          isError, durationMs, toolContext,
        });

        const inputStr = JSON.stringify(input).slice(0, 200);
        const resultStr = result.slice(0, 300).replace(/\n/g, ' ');
        log.info(`Tool ${tc.name} ${durationMs}ms ${isError ? 'ERROR' : 'ok'} | in: ${inputStr} | out: ${resultStr}`);
      }

      iterationLogs.push({
        iter: iterations, ctxMessages: contextMessages.length, ctxChars,
        stopReason, textChars: iterText.length,
        tools: pendingToolCalls.map((t) => t.name),
        toolResultChars: toolResults.map((t) => t.content.length),
      });

      messages.push({ role: 'user', content: toolResults as any });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('abort')) {
      aborted = true;
    } else {
      return {
        text: finalText,
        messages,
        usage: totalUsage,
        iterations: iterations + 1,
        toolCalls: allToolCalls,
        aborted: false,
        error: errorMsg,
      };
    }
  }

  return {
    text: finalText,
    messages,
    usage: totalUsage,
    iterations: iterations + 1,
    toolCalls: allToolCalls,
    aborted,
    iterationLogs,
  };
}
