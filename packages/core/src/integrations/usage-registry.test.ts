import { describe, expect, it } from 'vitest';
import { FORGE_GUIDES } from '../guides/registry.js';
import { getIntegrationGuide, getIntegrationUsage, INTEGRATION_USAGE } from './usage-registry.js';

describe('usage-registry', () => {
  it('getIntegrationUsage falls back for an unconnected/unknown provider', () => {
    expect(getIntegrationUsage('not-a-real-provider')).toBe('Project-specific integration.');
  });

  it('getIntegrationGuide returns the seeded slug for coolify, undefined for providers without one', () => {
    expect(getIntegrationGuide('coolify')).toBe('deploy-safety');
    expect(getIntegrationGuide('postman')).toBeUndefined();
    expect(getIntegrationGuide('epodsystem')).toBeUndefined();
    expect(getIntegrationGuide('not-a-real-provider')).toBeUndefined();
  });

  it('every guide slug referenced in INTEGRATION_USAGE exists in the capability-guide registry', () => {
    const knownSlugs = new Set(FORGE_GUIDES.map((g) => g.slug));
    for (const [provider, entry] of Object.entries(INTEGRATION_USAGE)) {
      if (entry.guide) {
        expect(knownSlugs.has(entry.guide), `${provider} -> guide '${entry.guide}'`).toBe(true);
      }
    }
  });
});
