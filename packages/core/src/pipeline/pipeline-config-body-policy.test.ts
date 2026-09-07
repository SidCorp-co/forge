import { describe, expect, it } from 'vitest';
import {
  defaultStatesConfig,
  PIPELINE_CONFIG_DEFAULTS,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';

/**
 * ISS-969 — `states[stage].bodyPolicy`.
 *
 * The property under test is mostly an ABSENCE, so each case names the write
 * that would prove it broken: a default appearing anywhere, a component the
 * registry cannot supply, or a slot component in a root's place.
 */
describe('bodyPolicy (ISS-969)', () => {
  it('accepts a root component at a stage', () => {
    const out = pipelineConfigSchema.parse({
      states: { open: { bodyPolicy: { requireComponent: 'forge-outcome' } } },
    });
    expect(out.states?.open?.bodyPolicy).toEqual({ requireComponent: 'forge-outcome' });
  });

  it('refuses a component the registry does not declare', () => {
    const out = pipelineConfigSchema.safeParse({
      states: { open: { bodyPolicy: { requireComponent: 'forge-nonsense' } } },
    });
    expect(out.success).toBe(false);
  });

  // cm:why a slot is the near-miss that would otherwise pass: `forge-finding` is a real component name, it is simply one no body can OPEN with, so a stage requiring it could never be satisfied by any write
  it('refuses a SLOT component, which no body can carry as its root', () => {
    const out = pipelineConfigSchema.safeParse({
      states: { open: { bodyPolicy: { requireComponent: 'forge-finding' } } },
    });
    expect(out.success).toBe(false);
  });

  it('refuses an unknown key beside it rather than dropping it silently', () => {
    const out = pipelineConfigSchema.safeParse({
      states: { open: { bodyPolicy: { requireComponent: 'forge-outcome', warnOnly: true } } },
    });
    expect(out.success).toBe(false);
  });

  // cm:guard OFF everywhere is the safety property of the whole feature, and these two are where an accidental default would arrive: a `.default()` on the field, or a key added to `defaultStatesConfig()`. Both would refuse comment writes on every project in the fleet at once.
  it('is absent from a document that declares nothing', () => {
    const out = pipelineConfigSchema.parse({ states: { open: { enabled: true } } });
    expect('bodyPolicy' in (out.states?.open ?? {})).toBe(false);
  });

  it('is absent from the shipped defaults, at every stage', () => {
    for (const stage of Object.values(defaultStatesConfig())) {
      expect('bodyPolicy' in stage).toBe(false);
    }
    for (const stage of Object.values(PIPELINE_CONFIG_DEFAULTS.states ?? {})) {
      expect('bodyPolicy' in (stage ?? {})).toBe(false);
    }
  });
});
