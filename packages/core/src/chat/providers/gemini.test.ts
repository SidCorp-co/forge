import { describe, expect, it } from 'vitest';
import { createGeminiProvider, type GeminiClient, type GeminiContent } from './gemini.js';
import type { ChatMessage } from './types.js';

function capturingProvider() {
  const seen: { contents: GeminiContent[]; systemInstruction?: string | undefined }[] = [];
  const client: GeminiClient = {
    models: {
      generateContentStream(args) {
        seen.push({ contents: args.contents, systemInstruction: args.config?.systemInstruction });
        return Promise.resolve(
          (async function* () {
            yield { text: 'ok' };
          })(),
        );
      },
    },
  };
  const provider = createGeminiProvider({
    apiKey: 'k',
    defaultModel: 'gemini-2.5-flash',
    loadSdk: () =>
      Promise.resolve({
        GoogleGenAI: class {
          models = client.models;
        } as never,
      }),
  });
  return { provider, seen };
}

async function drain(messages: ChatMessage[]) {
  const { provider, seen } = capturingProvider();
  for await (const _event of provider.stream({ model: 'm', messages })) {
  }
  return seen[0];
}

const DATA_URI = 'data:image/png;base64,QUJD';

describe('gemini adapter — multimodal content', () => {
  it('translates an image part into native inlineData instead of dropping it', async () => {
    const call = await drain([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is wrong with this screen?' },
          { type: 'image_url', image_url: { url: DATA_URI } },
        ],
      },
    ]);
    expect(call?.contents[0]?.parts).toEqual([
      { text: 'what is wrong with this screen?' },
      { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('drops a remote image URL — Gemini cannot authenticate to fetch it', async () => {
    const call = await drain([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'https://chat.example.com/file-upload/a/b.png' } },
        ],
      },
    ]);
    expect(call?.contents[0]?.parts).toEqual([{ text: 'look' }]);
  });

  it('leaves a plain string turn exactly as it was', async () => {
    const call = await drain([{ role: 'user', content: 'hello' }]);
    expect(call?.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] });
  });

  it('keeps a tool-call assistant turn (null content) as an empty text part', async () => {
    const call = await drain([{ role: 'assistant', content: null }]);
    expect(call?.contents[0]).toEqual({ role: 'model', parts: [{ text: '' }] });
  });

  it('folds the system message into systemInstruction, not contents', async () => {
    const call = await drain([
      { role: 'system', content: 'you are Babo' },
      { role: 'user', content: 'hi' },
    ]);
    expect(call?.systemInstruction).toBe('you are Babo');
    expect(call?.contents).toHaveLength(1);
  });
});
