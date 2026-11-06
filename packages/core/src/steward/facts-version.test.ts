// ISS-1044: the steward's facts version moves when what a gateway act is told moves, or when the
// revision naming a rewording outside those methods does, and holds otherwise, so a note written
// under it reads stale exactly when core has reworded what it states.
//
// @direct-test-of packages/core/src/steward/facts-version.ts

import { describe, expect, it } from 'vitest';
import {
  factsVersionOf,
  gatewayMethods,
  STEWARD_FACTS_REVISION,
  stewardFactsVersion,
} from './facts-version.js';
import { actPrompt } from './prompts.js';

describe("the steward's facts version (ISS-1044)", () => {
  it('is one digest of the revision and every gateway method, the same on every read (happy)', () => {
    const now = stewardFactsVersion();
    expect(now).toMatch(/^[0-9a-f]{16}$/);
    expect(stewardFactsVersion()).toBe(now);
    expect(factsVersionOf(STEWARD_FACTS_REVISION, gatewayMethods())).toBe(now);
  });

  it('moves when a gateway method is reworded, or the revision is (the business rule)', () => {
    const methods = gatewayMethods();
    const now = factsVersionOf(STEWARD_FACTS_REVISION, methods);
    const reworded = methods.map((m, i) => (i === 0 ? `${m} Reworded.` : m));
    expect(factsVersionOf(STEWARD_FACTS_REVISION, reworded)).not.toBe(now);
    expect(factsVersionOf(`${STEWARD_FACTS_REVISION}+1`, methods)).not.toBe(now);
  });

  it("reads the output check's method, which ISS-1035 and ISS-1040 reworded, and no runner job's (boundary)", () => {
    const methods = gatewayMethods();
    expect(methods).toContain(actPrompt('output_check'));
    expect(methods).not.toContain(actPrompt('triage_draft'));
    expect(methods).not.toContain(actPrompt('release_followthrough'));
  });

  it('keeps the methods apart, so moving words between two is a change (edge)', () => {
    expect(factsVersionOf('r', ['ab', 'c'])).not.toBe(factsVersionOf('r', ['a', 'bc']));
  });
});
