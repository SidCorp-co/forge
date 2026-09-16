/**
 * The four refusals that make `role`/`stages` a declaration rather than a guess.
 *
 * `binding-shape.ts` is shared by both creation doors — `POST /api/projects/:id/integrations`
 * and `POST /api/integration-connections/:id/bindings` — so a caller who reaches the same wrong
 * shape through the second door gets the same sentence. Before this file none of the four had an
 * assertion of its own: they were reachable only through the two route suites, and a refusal that
 * quietly became a normalisation would have gone unnoticed in both.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bindingShapeFields,
  cannotDeployMessage,
  checkBindingShape,
  checkRoleStagesPairing,
} from './binding-shape.js';

const pairing = z.object(bindingShapeFields).superRefine(checkRoleStagesPairing);
const withProvider = z
  .object({ provider: z.string(), ...bindingShapeFields })
  .superRefine(checkBindingShape);

function refusal(result: z.ZodSafeParseResult<unknown>): string {
  expect(result.success).toBe(false);
  if (result.success) throw new Error('unreachable');
  return result.error.issues.map((i) => i.message).join(' | ');
}

describe('the shapes a `role`/`stages` pair may take', () => {
  it('accepts a service binding that declares no stages', () => {
    expect(pairing.safeParse({ role: 'service' }).success).toBe(true);
  });

  it.each([[['preview']], [['live']], [['preview', 'live']], [['live', 'preview']]])(
    'accepts a deploy binding declaring %j',
    (stages) => {
      expect(pairing.safeParse({ role: 'deploy', stages }).success).toBe(true);
    },
  );
});

describe('the shapes it refuses by name', () => {
  it('refuses stages on a service binding rather than dropping them', () => {
    const msg = refusal(pairing.safeParse({ role: 'service', stages: ['live'] }));
    expect(msg).toContain('serves no stage');
    // The way out is carried in the refusal itself.
    expect(msg).toContain('role: "deploy"');
  });

  it('refuses a stageless deploy binding rather than defaulting one', () => {
    const msg = refusal(pairing.safeParse({ role: 'deploy', stages: [] }));
    expect(msg).toContain('must declare at least one stage');
    expect(msg).toContain('["preview","live"]');
  });

  it('refuses a deploy binding with no `stages` key at all', () => {
    expect(pairing.safeParse({ role: 'deploy' }).success).toBe(false);
  });

  it('refuses a duplicated stage rather than de-duplicating it', () => {
    const msg = refusal(pairing.safeParse({ role: 'deploy', stages: ['live', 'live'] }));
    expect(msg).toContain('is a set');
    expect(msg).toContain('["live","live"]');
  });

  it('refuses a stage outside the declared vocabulary', () => {
    expect(pairing.safeParse({ role: 'deploy', stages: ['prod'] }).success).toBe(false);
  });

  it('refuses a role outside the declared vocabulary, and has no default for it', () => {
    expect(pairing.safeParse({ role: 'staging' }).success).toBe(false);
    expect(pairing.safeParse({}).success).toBe(false);
  });
});

describe('the provider-capability half, on the door that carries a provider', () => {
  it('accepts a deploy binding on a provider with a deploy adapter', () => {
    const ok = withProvider.safeParse({ provider: 'coolify', role: 'deploy', stages: ['live'] });
    expect(ok.success).toBe(true);
  });

  it('refuses a deploy binding on a provider with none, listing the ones that have it', () => {
    const msg = refusal(
      withProvider.safeParse({ provider: 'sentry', role: 'deploy', stages: ['live'] }),
    );
    expect(msg).toContain(cannotDeployMessage('sentry'));
    expect(msg).toContain('coolify');
  });

  it('accepts that same provider as a service binding', () => {
    expect(withProvider.safeParse({ provider: 'sentry', role: 'service' }).success).toBe(true);
  });
});
