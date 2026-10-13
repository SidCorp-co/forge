import { describe, expect, it } from 'vitest';
import {
  mergePipelineConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';

describe('pipeline config rank (ISS-1336)', () => {
  const issuesOf = (value: unknown) =>
    JSON.stringify(pipelineConfigSchema.safeParse(value).error?.issues);

  it('is optional, so a document that sets none keeps the built-in table', () => {
    expect('rank' in pipelineConfigSchema.parse({ enabled: true })).toBe(false);
  });

  it('accepts one override at a time', () => {
    const out = pipelineConfigSchema.parse({ rank: { priority: { high: 35 }, ageCap: null } });
    expect(out.rank).toEqual({ priority: { high: 35 }, ageCap: null });
  });

  it('refuses a retired key by name rather than dropping it', () => {
    expect(pipelineConfigSchema.safeParse({ rank: { windowCap: 40 } }).success).toBe(false);
    expect(issuesOf({ rank: { windowCap: 40 } })).toContain('rank.windowCap');
    expect(issuesOf({ rank: { readCap: 60 } })).toContain('rank.readCap');
  });

  it('refuses an unknown weight and a non-number, both by name', () => {
    expect(issuesOf({ rank: { speed: 1 } })).toContain('rank.speed');
    expect(issuesOf({ rank: { blocks: 'many' } })).toContain('rank.blocks');
  });

  it('is a key a patch may name, and a patch replaces the stored table as a whole', () => {
    expect(pipelineConfigPatchSchema.safeParse({ rank: { blocks: 5 } }).success).toBe(true);
    const merged = mergePipelineConfig(
      { rank: { priority: { high: 35 } } },
      { rank: { blocks: 5 } },
    );
    expect(merged.rank).toEqual({ blocks: 5 });
  });
});
