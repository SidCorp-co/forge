// ISS-726: callFastModel used to gate on LITELLM_API_URL alone, so on a
// deployment configured with GEMINI_API_KEY only it returned null forever and
// auto-title + memory-v2 extraction/consolidation were silently no-ops.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({
  env: {} as {
    LITELLM_API_URL: string | undefined;
    LITELLM_API_KEY: string | undefined;
    LITELLM_MODEL: string;
    GEMINI_API_KEY: string | undefined;
    GEMINI_MODEL: string;
  },
}));

vi.mock('../config/env.js', () => ({ env }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { callFastModel, fastModelConfigured } = await import('./llm.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  env.LITELLM_API_URL = undefined;
  env.LITELLM_API_KEY = undefined;
  env.LITELLM_MODEL = 'fast-model';
  env.GEMINI_API_KEY = undefined;
  env.GEMINI_MODEL = 'gemini-test';
});

describe('callFastModel backend selection', () => {
  it('reports unconfigured and calls nothing when neither backend has credentials', async () => {
    expect(fastModelConfigured()).toBe(false);
    expect(await callFastModel('hi', 10)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when only GEMINI_API_KEY is set', async () => {
    env.GEMINI_API_KEY = 'gkey';
    fetchMock.mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '  a title  ' }] } }] }),
    );

    expect(fastModelConfigured()).toBe(true);
    expect(await callFastModel('summarize', 20)).toBe('a title');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent',
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gkey');
  });

  it('joins multi-part Gemini candidates rather than dropping all but the first', async () => {
    env.GEMINI_API_KEY = 'gkey';
    fetchMock.mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two' }] } }] }),
    );
    expect(await callFastModel('p', 20)).toBe('one two');
  });

  it('prefers LiteLLM when both backends are configured', async () => {
    env.LITELLM_API_URL = 'http://litellm.test';
    env.GEMINI_API_KEY = 'gkey';
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'from litellm' } }] }),
    );

    expect(await callFastModel('p', 20)).toBe('from litellm');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://litellm.test/chat/completions');
  });

  it('returns null (not a throw) when the Gemini call is rejected', async () => {
    env.GEMINI_API_KEY = 'gkey';
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as unknown as Response);
    expect(await callFastModel('p', 20)).toBeNull();
  });
});
