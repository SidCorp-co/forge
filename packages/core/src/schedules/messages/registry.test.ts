import { describe, expect, it } from 'vitest';
import {
  getImprovementMessage,
  improvementMessages,
  listImprovementMessages,
} from './registry.js';

describe('improvementMessages registry', () => {
  it('listImprovementMessages returns an array', () => {
    const list = listImprovementMessages();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toBe(improvementMessages);
  });

  it('all messages have required fields', () => {
    for (const msg of listImprovementMessages()) {
      expect(msg.key).toBeTruthy();
      expect(msg.title).toBeTruthy();
      expect(msg.message).toBeTruthy();
      expect(msg.rationale).toBeTruthy();
      expect(msg.category).toBeTruthy();
      expect(typeof msg.version).toBe('number');
      expect(typeof msg.recommended).toBe('boolean');
      expect(['propose', 'auto']).toContain(msg.defaultMode);
    }
  });

  it('all keys are unique', () => {
    const keys = listImprovementMessages().map((m) => m.key);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('getImprovementMessage returns undefined for unknown key', () => {
    expect(getImprovementMessage('non-existent-key')).toBeUndefined();
  });

  it('getImprovementMessage returns the message for a known key', () => {
    const list = listImprovementMessages();
    if (list.length === 0) {
      // No seed messages yet (ISS-548 adds them); skip lookup test.
      return;
    }
    const first = list[0];
    expect(getImprovementMessage(first.key)).toBe(first);
  });
});
