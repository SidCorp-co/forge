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
  GoogleGenAI: new (init: {
    apiKey: string;
  }) => GeminiClient;
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

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
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
    const parts = toGeminiParts(m.content);
    if (m.role === 'system') {
      systemParts.push(parts.map((p) => ('text' in p ? p.text : '')).join(''));
      continue;
    }
    // Gemini's simple adapter has no tool-calling path (only LiteLLM is wired
    // for tools in ISS-604); fold any tool/assistant text in as plain turns.
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }
  if (systemParts.length === 0) return { contents };
  return { systemInstruction: systemParts.join('\n\n'), contents };
}

// cm:guard no regex FLAGS newer than es2017 in packages/core — `pnpm --filter web-v2 build` type-checks core's SOURCES against web-v2's own lower target, so a flag core's tsconfig accepts (here `/s`) compiles clean in core and fails the WEB build; `[\s\S]` carries dotAll's meaning with no flag. Broke the Coolify deploy of 2a1e19c0, 2026-08-31.
const DATA_URI_RE = /^data:([^;,]+);base64,([\s\S]*)$/;

// cm:edge contract -> packages/core/src/chat/providers/types.ts — ChatContentPart is the OpenAI wire shape; this is the ONLY place it is translated into Gemini's native `inlineData`, and nothing type-checks the two spellings against each other
function toGeminiParts(content: ChatMessage['content']): GeminiPart[] {
  if (content === null) return [{ text: '' }];
  if (typeof content === 'string') return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
      continue;
    }
    const match = DATA_URI_RE.exec(part.image_url.url);
    // cm:why a non-`data:` URI is dropped rather than forwarded — Gemini would have to fetch it itself, and every image Forge carries sits behind a credential the model host does not have, so the remote read 403s and the model reports "no image" instead of an error anyone can see
    if (match?.[1] && match[2]) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
