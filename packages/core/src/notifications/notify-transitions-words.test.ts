import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { bodyForStatus, transitionTitle } = await import('./notify-transitions.js');

// ISS-1229 r9: the status-change notification a person reads named the status as stored.
describe('the status-change notification, in the words the screen uses', () => {
  it('names the status it moved to by its label', () => {
    expect(transitionTitle('ISS-4 — Fix login', 'awaiting_release')).toBe(
      'ISS-4 — Fix login moved to Awaiting release',
    );
  });

  it('says where it moved by label where no reason was given', () => {
    expect(bodyForStatus('in_progress')).toBe('Moved to In progress.');
  });

  it('keeps the reason a person wrote', () => {
    expect(bodyForStatus('in_progress', ' picked up again ')).toBe('picked up again');
  });

  // ISS-1228 r20, judge-62: the bell showed the stored reason autonomous_rescue_cap_reached.
  it('words a stored reason code as a sentence, never the code', () => {
    const body = bodyForStatus('needs_info', 'autonomous_rescue_cap_reached');
    expect(body).toBe(
      'Forge sent it back to its agent 3 times on this run without it moving on, so it stopped and waits on your answer.',
    );
    expect(body).not.toMatch(/_/);
  });

  it("takes the status's own sentence for a code it has no words for", () => {
    expect(bodyForStatus('needs_info', 'some_unworded_code')).toBe(
      'The driver asked a question — it cannot continue until you answer.',
    );
    expect(bodyForStatus('closed', 'reconciler_autonomous_wedge_reset')).toBe('Closed.');
  });
});
