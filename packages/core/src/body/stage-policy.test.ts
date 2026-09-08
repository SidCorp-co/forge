/**
 * The switch, proved by watching it move.
 *
 * Each case names what would have to be true for it to go red, because a gate
 * that is off everywhere by default is indistinguishable from a gate that does
 * not work until something is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  BodyComponentRequiredError,
  refuseMissingComponent,
  resolveStageBodyPolicy,
} from './stage-policy.js';

const POLICY_ON = {
  pipelineConfig: { states: { open: { bodyPolicy: { requireComponent: 'forge-outcome' } } } },
};

describe('resolveStageBodyPolicy', () => {
  it('reads nothing out of a project that declared nothing', () => {
    expect(resolveStageBodyPolicy({ pipelineConfig: { states: {} } }, 'open')).toBeNull();
    expect(resolveStageBodyPolicy({ pipelineConfig: null }, 'open')).toBeNull();
    expect(resolveStageBodyPolicy(null, 'open')).toBeNull();
    expect(resolveStageBodyPolicy(undefined, 'open')).toBeNull();
  });

  it('reads a declared component at the stage that declared it', () => {
    expect(resolveStageBodyPolicy(POLICY_ON, 'open')).toEqual({
      stage: 'open',
      requireComponent: 'forge-outcome',
    });
  });

  // cm:why the neighbouring stage is the case that matters: a policy that leaked one stage sideways would refuse every comment on the project and read, from the outside, exactly like the intended rule working
  it('reads nothing at a stage the project did not declare', () => {
    expect(resolveStageBodyPolicy(POLICY_ON, 'in_progress')).toBeNull();
    expect(resolveStageBodyPolicy(POLICY_ON, 'closed')).toBeNull();
  });

  it('reads an empty string as nothing declared', () => {
    const doc = { pipelineConfig: { states: { open: { bodyPolicy: { requireComponent: '' } } } } };
    expect(resolveStageBodyPolicy(doc, 'open')).toBeNull();
  });
});

describe('refuseMissingComponent', () => {
  const policy = { stage: 'open' as const, requireComponent: 'forge-outcome' };

  it('accepts anything while no policy is declared', () => {
    expect(
      refuseMissingComponent({
        policy: null,
        agency: 'agent',
        format: 'markdown',
        template: null,
      }),
    ).toBeNull();
  });

  it('refuses an agent body that omits the component', () => {
    const refusal = refuseMissingComponent({
      policy,
      agency: 'agent',
      format: 'markdown',
      template: null,
    });
    expect(refusal).toBeInstanceOf(BodyComponentRequiredError);
    expect(refusal?.code).toBe('BODY_COMPONENT_REQUIRED');
  });

  // cm:guard the message is the deliverable, the same as `BodyInvalidError`'s: a writer told only "refused" has nothing to correct, and this is the only place the component and the stage are named
  it('names the component, the stage and what to write', () => {
    const refusal = refuseMissingComponent({
      policy,
      agency: 'agent',
      format: 'markdown',
      template: null,
    });
    expect(refusal?.message).toContain('forge-outcome');
    expect(refusal?.message).toContain('open');
    expect(refusal?.message).toContain('</forge-outcome>');
    expect(refusal?.details).toMatchObject({ requires: 'forge-outcome', stage: 'open' });
  });

  it('accepts an agent body that carries the component', () => {
    expect(
      refuseMissingComponent({
        policy,
        agency: 'agent',
        format: 'html',
        template: 'forge-outcome',
      }),
    ).toBeNull();
  });

  it('refuses an agent body carrying a DIFFERENT component', () => {
    const refusal = refuseMissingComponent({
      policy,
      agency: 'agent',
      format: 'html',
      template: 'forge-review',
    });
    expect(refusal?.message).toContain('`<forge-review>` body');
  });

  // cm:guard NULL is not 'human' — a row written before `author_agency` existed has no answer, and guessing one would put every historical comment into the population the fraction claims to describe.
  it('accepts a body whose agency was never recorded', () => {
    expect(
      refuseMissingComponent({ policy, agency: null, format: 'markdown', template: null }),
    ).toBeNull();
  });

  it('never refuses a person, at any stage, under any policy', () => {
    expect(
      refuseMissingComponent({
        policy,
        agency: 'human',
        format: 'markdown',
        template: null,
      }),
    ).toBeNull();
  });
});
