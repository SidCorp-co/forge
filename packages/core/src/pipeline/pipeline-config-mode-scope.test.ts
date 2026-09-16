/**
 * ISS-994 — how far `states[X].mode` reaches, held by the two schemas that
 * decide it.
 *
 * The pair is deliberately asymmetric and each half is load-bearing: the
 * canonical schema STRIPS a non-entry `mode` so a project that stored one
 * still parses, and the PATCH schema REFUSES one so an operator setting it is
 * told rather than handed a gate that holds nothing. Swap either and one of
 * these goes red.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultStatesConfig,
  pipelineConfigPatchSchema,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';

describe('states[X].mode reaches only the entry status (ISS-994)', () => {
  it('keeps mode on the entry status, where isEntryGateClosed reads it', () => {
    const out = pipelineConfigSchema.parse({ states: { open: { mode: 'manual' } } });
    expect(out.states?.open?.mode).toBe('manual');
  });

  it('strips mode from a stage that is not the entry status, keeping the stage', () => {
    const out = pipelineConfigSchema.parse({
      states: { awaiting_release: { enabled: true, mode: 'auto', model: 'sonnet' } },
    });
    expect(out.states?.awaiting_release).toEqual({ enabled: true, model: 'sonnet' });
  });

  it('parses a stored document that names a non-entry mode rather than refusing it', () => {
    const stored = {
      enabled: true,
      states: { needs_info: { mode: 'manual' }, awaiting_release: { mode: 'auto' } },
    };
    expect(() => pipelineConfigSchema.parse(stored)).not.toThrow();
    expect(pipelineConfigSchema.parse(stored).enabled).toBe(true);
  });

  it('parses a states map naming only the entry status, which is what most projects store', () => {
    const out = pipelineConfigSchema.parse({ states: { open: { enabled: true } } });
    expect(out.states?.open?.enabled).toBe(true);
    expect(out.states?.in_progress).toBeUndefined();
  });

  it('refuses a PATCH that sets mode on a stage that is not the entry status', () => {
    const result = pipelineConfigPatchSchema.safeParse({
      states: { in_progress: { mode: 'manual' } },
    });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain('in_progress');
    expect(message).toContain('open');
  });

  it('accepts a PATCH that sets mode on the entry status', () => {
    const result = pipelineConfigPatchSchema.safeParse({ states: { open: { mode: 'manual' } } });
    expect(result.success).toBe(true);
  });

  it('defaults mode at the entry status and nowhere else', () => {
    const config = defaultStatesConfig();
    expect(config.open?.mode).toBe('auto');
    expect((config.in_progress as { mode?: string }).mode).toBeUndefined();
    expect((config.needs_info as { mode?: string }).mode).toBeUndefined();
    expect((config.awaiting_release as { mode?: string }).mode).toBeUndefined();
  });
});
