import OpenAI from 'openai';
import type {
  AIProvider,
  StreamParams,
  StreamEvent,
  Message,
  MessageContent,
  ToolDefinition,
} from './provider';

type ChatMessage = OpenAI.ChatCompletionMessageParam;

function mapMessages(messages: Message[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      if (m.role === 'system') return { role: 'system' as const, content: m.content };
      if (m.role === 'assistant') return { role: 'assistant' as const, content: m.content };
      return { role: 'user' as const, content: m.content };
    }

    const contents = m.content as MessageContent[];

    const toolResults = contents.filter((c) => c.type === 'tool_result');
    if (toolResults.length > 0) {
      const tr = toolResults[0] as Extract<MessageContent, { type: 'tool_result' }>;
      return {
        role: 'tool' as const,
        tool_call_id: tr.toolUseId,
        content: tr.content,
      };
    }

    const toolUses = contents.filter((c) => c.type === 'tool_use');
    if (toolUses.length > 0) {
      const textParts = contents.filter((c) => c.type === 'text');
      const textContent = textParts.map((c) => (c as Extract<MessageContent, { type: 'text' }>).text).join('');
      return {
        role: 'assistant' as const,
        content: textContent || null,
        tool_calls: toolUses.map((c) => {
          const tu = c as Extract<MessageContent, { type: 'tool_use' }>;
          return {
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          };
        }),
      };
    }

    const text = contents
      .filter((c) => c.type === 'text')
      .map((c) => (c as Extract<MessageContent, { type: 'text' }>).text)
      .join('');
    if (m.role === 'assistant') return { role: 'assistant' as const, content: text };
    return { role: 'user' as const, content: text };
  });
}

function mapTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export class OpenAIProvider implements AIProvider {
  id: string;
  private client: OpenAI;

  constructor(apiKey: string, opts?: { baseURL?: string; id?: string }) {
    this.client = new OpenAI({ apiKey, baseURL: opts?.baseURL });
    this.id = opts?.id || 'openai';
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const messages = mapMessages(params.messages);
    if (params.systemPrompt) {
      messages.unshift({ role: 'system', content: params.systemPrompt });
    }

    const reqParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens ?? 8192,
    };

    if (params.tools?.length) {
      reqParams.tools = mapTools(params.tools);
    }

    const stream = await this.client.chat.completions.create(reqParams, {
      signal: params.signal,
    });

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // Capture usage — may arrive on a separate chunk after finish_reason
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
        const details = (chunk.usage as any).prompt_tokens_details;
        if (details?.cached_tokens) cacheReadTokens = details.cached_tokens;
        if (details?.cache_creation_tokens) cacheWriteTokens = details.cache_creation_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      if (delta.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (tc.id) {
            toolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
            yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' };
          }
          if (tc.function?.arguments) {
            const existing = toolCalls.get(idx);
            if (existing) {
              existing.args += tc.function.arguments;
              if (tc.function.name) existing.name = tc.function.name;
              yield { type: 'tool_use_delta', id: existing.id, partialInput: tc.function.arguments };
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        for (const tc of toolCalls.values()) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
          yield { type: 'tool_use_end', id: tc.id, name: tc.name, input };
        }
        toolCalls.clear();

        if (choice.finish_reason !== 'stop') {
          yield { type: 'text_end' };
        }
      }
    }

    // Yield message_end after stream completes so usage from the final chunk is captured
    yield {
      type: 'message_end',
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      stopReason: finishReason || 'end_turn',
    };
  }
}
