/**
 * ISS-1056 — `pipelineConfig.assistantWeekly`: absent by default, the full shape accepted, a
 * missing field, a malformed issue key, an empty model or an unknown key refused.
 */

import { describe, expect, it } from 'vitest';
import { pipelineConfigSchema } from './pipeline-config-schema.js';

describe('assistantWeekly (ISS-1056)', () => {
  const on = {
    enabled: true,
    pinnedIssue: 'ISS-1060',
    judgeProviderId: 'litellm',
    judgeModel: 'cx/gpt-6-astra',
  };

  it('is absent by default and accepts the full shape with an optional source', () => {
    expect(pipelineConfigSchema.parse({}).assistantWeekly).toBeUndefined();
    expect(pipelineConfigSchema.parse({ assistantWeekly: on }).assistantWeekly).toEqual(on);
    expect(
      pipelineConfigSchema.parse({ assistantWeekly: { ...on, source: 'web' } }).assistantWeekly
        ?.source,
    ).toBe('web');
  });

  it('refuses a missing field, a key that is not an issue key, an empty model and an unknown key', () => {
    const { enabled: _e, ...noEnabled } = on;
    expect(pipelineConfigSchema.safeParse({ assistantWeekly: noEnabled }).success).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({ assistantWeekly: { ...on, pinnedIssue: '1060' } }).success,
    ).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({ assistantWeekly: { ...on, pinnedIssue: 'iss-1060' } })
        .success,
    ).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({ assistantWeekly: { ...on, judgeModel: '' } }).success,
    ).toBe(false);
    expect(
      pipelineConfigSchema.safeParse({ assistantWeekly: { ...on, cron: '0 4 * * 1' } }).success,
    ).toBe(false);
  });
});
