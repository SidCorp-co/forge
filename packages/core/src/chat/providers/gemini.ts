/**
 * v1 EPIC 1 (ISS-270) — Google Gemini chat adapter via `@google/genai`.
 *
 * Uses `models.generateContentStream` for SSE-shaped streaming. The SDK
 * loaded lazily so unused installs (and the test suite when GEMINI_API_KEY
 * is unset) don't pay the import cost.
 */

import type {
  ChatMessage,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatStreamUsage,
} from './types.js';

export interface GeminiConfig {
  apiKey: string;
  defaultModel: string;
  /** Override the SDK loader for tests. */
  loadSdk?: () => Promise<GeminiSdk>;
}

export interface GeminiSdk {
  /** Constructor for `GoogleGenAI`-shaped client. */
  GoogleGenAI: new (init: { apiKey: string }) => GeminiClient;
}

export interface GeminiClient {
  models: {
    generateContentStream(args: {
      model: string;
      contents: GeminiContent[];
      config?: { systemInstruction?: string | undefined } | undefined;
    }): Promise<AsyncIterable<GeminiStreamChunk>>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface GeminiStreamChunk {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const defaultLoader: () => Promise<GeminiSdk> = () =>
  // The SDK is an optional runtime dep — installs only when GEMINI_API_KEY
  // is configured. The dynamic import keeps the test suite green without it.
  import('@google/genai') as unknown as Promise<GeminiSdk>;

export function createGeminiProvider(cfg: GeminiConfig): ChatProvider {
  const loadSdk = cfg.loadSdk ?? defaultLoader;
  let clientPromise: Promise<GeminiClient> | undefined;

  const getClient = async (): Promise<GeminiClient> => {
    if (!clientPromise) {
      clientPromise = loadSdk().then((sdk) => new sdk.GoogleGenAI({ apiKey: cfg.apiKey }));
    }
    return clientPromise;
  };

  return {
    id: 'gemini',
    defaultModel: cfg.defaultModel,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      const { systemInstruction, contents } = mapMessages(req.messages);
      let stream: AsyncIterable<GeminiStreamChunk>;
      try {
        const client = await getClient();
        const args: {
          model: string;
          contents: GeminiContent[];
          config?: { systemInstruction?: string | undefined };
        } = { model: req.model, contents };
        if (systemInstruction) args.config = { systemInstruction };
        stream = await client.models.generateContentStream(args);
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
        return;
      }

      try {
        for await (const chunk of stream) {
          if (req.signal?.aborted) {
            yield { type: 'error', message: 'aborted' };
            return;
          }
          if (typeof chunk.text === 'string' && chunk.text.length > 0) {
            yield { type: 'chunk', text: chunk.text };
          }
          if (chunk.usageMetadata) {
            const usage: ChatStreamUsage = {};
            if (chunk.usageMetadata.promptTokenCount !== undefined) {
              usage.promptTokens = chunk.usageMetadata.promptTokenCount;
            }
            if (chunk.usageMetadata.candidatesTokenCount !== undefined) {
              usage.completionTokens = chunk.usageMetadata.candidatesTokenCount;
            }
            if (chunk.usageMetadata.totalTokenCount !== undefined) {
              usage.totalTokens = chunk.usageMetadata.totalTokenCount;
            }
            yield { type: 'usage', usage };
          }
        }
        yield { type: 'done' };
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
      }
    },
  };
}

function mapMessages(messages: ChatMessage[]): {
  systemInstruction?: string;
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    const text = m.content ?? '';
    if (m.role === 'system') {
      systemParts.push(text);
      continue;
    }
    // Gemini's simple adapter has no tool-calling path (only LiteLLM is wired
    // for tools in ISS-604); fold any tool/assistant text in as plain turns.
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  }
  if (systemParts.length === 0) return { contents };
  return { systemInstruction: systemParts.join('\n\n'), contents };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
