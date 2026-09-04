// ISS-726 was a fast model that returned null forever while every log stayed
// clean, so these assert the two ways that recurs: a backend this module can
// call but fastModelConfigured() does not report, and a null that a caller
// cannot tell from "the model had nothing to say".

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({
  env: {} as {
    LITELLM_API_URL: string | undefined;
    LITELLM_API_KEY: string | undefined;
    LITELLM_MODEL: string;
  },
}));

vi.mock('../config/env.js', () => ({ env }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { callFastModel, fastModelConfigured } = await import('./llm.js');
const { logger } = await import('../logger.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  env.LITELLM_API_URL = undefined;
  env.LITELLM_API_KEY = undefined;
  env.LITELLM_MODEL = 'fast-model';
});

describe('callFastModel backend selection', () => {
  it('reports unconfigured and calls nothing when neither backend has credentials', async () => {
    expect(fastModelConfigured()).toBe(false);
    expect(await callFastModel('hi', 10)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('callFastModel budget exhaustion and reasoning control', () => {
  beforeEach(() => {
    env.LITELLM_API_URL = 'https://proxy.test';
    env.LITELLM_API_KEY = 'k';
  });

  const bodyOf = (call: number): Record<string, unknown> => {
    const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? '{}');
  };

  it("asks the endpoint not to reason, so the caller's max_tokens buys output", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'a title' } }] }),
    );

    expect(await callFastModel('prompt', 24)).toBe('a title');
    expect(bodyOf(0)).toMatchObject({ reasoning_effort: 'none', max_tokens: 24 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once with a bigger budget when the budget ran out before any output', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ finish_reason: 'length', message: { content: null } }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }] }),
      );

    expect(await callFastModel('prompt', 24)).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyOf(1);
    expect(retry.max_tokens).toBeGreaterThan(24);
    expect(retry.reasoning_effort).toBe('none');
  });

  it('says the budget ran out rather than returning a bare null a caller reads as "nothing to say"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: 'length', message: { content: null } }] }),
    );

    expect(await callFastModel('prompt', 24)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[1]));
    expect(warned.some((m) => m.includes('token budget exhausted'))).toBe(true);
  });

  it('drops reasoning_effort and retries when the endpoint rejects the parameter', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Unrecognized request argument supplied: reasoning_effort',
      } as unknown as Response)
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'plain' } }] }),
      );

    expect(await callFastModel('prompt', 400)).toBe('plain');
    const retry = bodyOf(1);
    expect(retry.reasoning_effort).toBeUndefined();
    expect(retry.max_tokens).toBe(400);
  });

  it('does not retry a 400 that rejects the content rather than the request shape', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'content filtered',
    } as unknown as Response);

    expect(await callFastModel('prompt', 400)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
