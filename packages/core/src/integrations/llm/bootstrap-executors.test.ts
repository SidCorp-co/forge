// Which sandbox executors a deployment's provider settings enable (REQ-32 BC-14). QA of ISS-430 on
// 0.4.0-dev.193: the code execution adapter rode the chat's ANTHROPIC_API_URL, which on dev is an
// Anthropic-format gateway (a gpt model behind it) serving neither the Files API nor the code
// execution tool, so every computation failed "the file upload ... answered http 400
// invalid_request_error: Request body is not valid JSON" after the project had been told its data
// leaves to Anthropic. The adapter is enabled only on the Claude API, and a deployment that has none
// says why by name.

import { describe, expect, it } from 'vitest';
import { providerExecutors } from './bootstrap.js';
import { CODE_EXECUTOR_ID } from './code-execution.js';

const GATEWAY = 'https://serp-api.musetools.com';
const settings = (over: Partial<Parameters<typeof providerExecutors>[0]> = {}) => ({
  ANTHROPIC_API_URL: 'https://api.anthropic.com',
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_MODEL: 'claude-sonnet-5',
  CODE_EXECUTION_API_URL: 'https://api.anthropic.com',
  CODE_EXECUTION_API_KEY: undefined,
  CODE_EXECUTION_MODEL: 'claude-sonnet-5',
  ...over,
});

describe('the code execution executor', () => {
  it('is not enabled on a chat gateway, and the deployment says why by name', () => {
    const got = providerExecutors(
      settings({
        ANTHROPIC_API_URL: GATEWAY,
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_MODEL: 'cx/gpt-5.6-terra',
      }),
    );
    expect(got.executors).toEqual([]);
    expect(got.unavailable).toHaveLength(1);
    expect(got.unavailable[0]).toContain(CODE_EXECUTOR_ID);
    expect(got.unavailable[0]).toContain(GATEWAY);
    expect(got.unavailable[0]).toContain('CODE_EXECUTION_API_KEY');
  });

  it('runs on the chat settings where they are the Claude API', () => {
    const got = providerExecutors(settings({ ANTHROPIC_API_KEY: 'k' }));
    expect(got.executors.map((e) => e.id)).toEqual([CODE_EXECUTOR_ID]);
    expect(got.unavailable).toEqual([]);
  });

  it('runs on its own key beside a chat gateway', () => {
    const got = providerExecutors(
      settings({ ANTHROPIC_API_URL: GATEWAY, ANTHROPIC_API_KEY: 'k', CODE_EXECUTION_API_KEY: 'c' }),
    );
    expect(got.executors.map((e) => e.id)).toEqual([CODE_EXECUTOR_ID]);
  });

  it('is not enabled with no provider key at all, and says so', () => {
    const got = providerExecutors(settings());
    expect(got.executors).toEqual([]);
    expect(got.unavailable[0]).toContain('no ANTHROPIC_API_KEY or CODE_EXECUTION_API_KEY');
  });
});
