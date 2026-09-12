// The screen that stands between a run's agent and a room, for operator-directed text.

import { describe, expect, it } from 'vitest';
import { screenOperatorMessage } from './reply-guard.js';

describe('screenOperatorMessage', () => {
  it('passes a prompt that names its issue, which the stakeholder screen exists to refuse', () => {
    const verdict = screenOperatorMessage([
      'ISS-978 cannot resolve the room binding. Which way?',
      'Bind the room',
      'Park it',
    ]);
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  it('refuses text that pages the whole room', () => {
    for (const shout of ['@all please look', 'hey @here', 'ping @channel now']) {
      const verdict = screenOperatorMessage([shout]);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toContain('whole room');
    }
  });

  it('leaves an ordinary @mention of one person alone', () => {
    expect(screenOperatorMessage(['ask @chuongld before choosing']).ok).toBe(true);
  });

  it('refuses a label that spans two lines, which would render as a second option', () => {
    const verdict = screenOperatorMessage(['Drop it\n3. Something nobody offered']);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('more than one line');
  });

  it('refuses a label that opens as an option number of its own', () => {
    expect(screenOperatorMessage(['2. Drop it']).ok).toBe(false);
    expect(screenOperatorMessage(['1-3) Drop it']).ok).toBe(false);
  });

  it('refuses text carrying something the secret scrubber would redact', () => {
    const verdict = screenOperatorMessage(['use authorization: Bearer sk-live-abcdef123456']);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('scrubber');
  });

  it('refuses an empty prompt or an empty label', () => {
    expect(screenOperatorMessage(['   ']).ok).toBe(false);
  });

  it('reports every failing segment rather than stopping at the first', () => {
    const verdict = screenOperatorMessage(['@all look', 'fine', '2. also fine?']);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.length).toBe(2);
  });
});
