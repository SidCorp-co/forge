import { describe, expect, it } from 'vitest';
import {
  ALWAYS_INJECT_ENFORCEMENT_NOTE,
  ALWAYS_INJECT_GUARANTEE_NOTE,
  ALWAYS_INJECT_MAX_CHARS,
  RESERVED_PROJECT_FACT_KEYS,
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
  unreservedProjectKeyRefusal,
} from './project-facts.js';

describe('RESERVED_PROJECT_FACT_KEYS', () => {
  it('is kebab-case throughout, which is what the template syntax accepts', () => {
    for (const key of RESERVED_PROJECT_FACT_KEYS) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('has no duplicates, so no key resolves twice', () => {
    expect(new Set(RESERVED_PROJECT_FACT_KEYS).size).toBe(RESERVED_PROJECT_FACT_KEYS.length);
  });

  it('still reserves production-branch after the column it read was renamed', () => {
    expect(RESERVED_PROJECT_FACT_KEYS).toContain('production-branch');
  });
});

describe('unreservedProjectKeyRefusal', () => {
  it('answers with text rather than nothing, since empty would delete the sentence', () => {
    expect(unreservedProjectKeyRefusal('house-style').trim().length).toBeGreaterThan(0);
  });

  it('quotes the reference back so the author can find it in the skill body', () => {
    expect(unreservedProjectKeyRefusal('house-style')).toContain('{{project:house-style}}');
  });

  it('names where the prose went and the exact call that fetches it', () => {
    const refusal = unreservedProjectKeyRefusal('house-style');
    expect(refusal).toContain('knowledge store');
    expect(refusal).toContain('forge_knowledge');
    expect(refusal).toContain('slug `house-style`');
  });

  it('carries the issue that moved it, so the change is traceable from the prompt', () => {
    expect(unreservedProjectKeyRefusal('anything')).toContain('ISS-1048');
  });
});

describe('the retired agentConfig keys', () => {
  it.each([
    ['projectFacts', RETIRED_PROJECT_FACTS_MESSAGE],
    ['projectFactsConfig', RETIRED_PROJECT_FACTS_CONFIG_MESSAGE],
  ])('refuses %s by name and says what to send instead', (key, message) => {
    expect(message).toContain(key);
    expect(message).toContain('knowledge');
    expect(message).toContain('forge_knowledge');
    expect(message).toContain('PUT /api/projects/:id/knowledge/:slug');
  });

  it('tells the projectFactsConfig caller the three values that replaced its boolean', () => {
    for (const value of ['always', 'on_demand', 'none']) {
      expect(RETIRED_PROJECT_FACTS_CONFIG_MESSAGE).toContain(value);
    }
  });
});

describe('the always-inject tier', () => {
  it('caps the sum of injected bodies at a positive number of characters', () => {
    expect(ALWAYS_INJECT_MAX_CHARS).toBeGreaterThan(0);
  });

  it('states the guarantee in one line, with no markdown', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toContain('`');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toContain('\n');
  });

  it('says what the flag guarantees and what it does not, since that is the whole point', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('READ');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('DONE');
  });

  it('keeps the enforcement detail out of the one-line note', () => {
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).not.toBe(ALWAYS_INJECT_GUARANTEE_NOTE);
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE.length).toBeGreaterThan(
      ALWAYS_INJECT_GUARANTEE_NOTE.length,
    );
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('leaves evidence a human can look at');
  });
});
