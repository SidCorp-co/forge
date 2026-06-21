import { describe, expect, it } from 'vitest';
import { ADDRESS_INHERITED_OPEN_ITEMS, CONSUMES_OPEN_ITEMS, getStatePrompt } from './index.js';

const OBLIGATION_MARKER = 'Address inherited open items';

describe('state-prompts — ADDRESS_INHERITED_OPEN_ITEMS obligation (ISS-537)', () => {
  it('consuming steps (plan/code/review/test/fix) carry the open-items obligation', () => {
    for (const step of ['plan', 'code', 'review', 'test', 'fix'] as const) {
      const prompt = getStatePrompt(step);
      expect(prompt, `${step} should contain obligation`).not.toBeNull();
      expect(prompt, `${step} missing obligation`).toContain(OBLIGATION_MARKER);
    }
  });

  it('non-consuming steps (clarify/triage/release) do NOT carry the obligation', () => {
    for (const step of ['clarify', 'triage', 'release'] as const) {
      const prompt = getStatePrompt(step);
      expect(prompt, `${step} should not contain obligation`).not.toContain(OBLIGATION_MARKER);
    }
  });

  it('CONSUMES_OPEN_ITEMS set includes exactly plan/code/review/test/fix', () => {
    expect(CONSUMES_OPEN_ITEMS.has('plan')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('code')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('review')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('test')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('fix')).toBe(true);
    expect(CONSUMES_OPEN_ITEMS.has('clarify')).toBe(false);
    expect(CONSUMES_OPEN_ITEMS.has('triage')).toBe(false);
    expect(CONSUMES_OPEN_ITEMS.has('release')).toBe(false);
  });

  it('ADDRESS_INHERITED_OPEN_ITEMS mentions re-query flow and max-3 cap', () => {
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('forge_agent_sessions.list');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('forge_agent_sessions.get');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('max 3 calls');
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('last-20 message tail');
  });

  it('ADDRESS_INHERITED_OPEN_ITEMS explicitly states prompt-layer guidance, not a status gate', () => {
    expect(ADDRESS_INHERITED_OPEN_ITEMS).toContain('not a status gate');
  });
});
