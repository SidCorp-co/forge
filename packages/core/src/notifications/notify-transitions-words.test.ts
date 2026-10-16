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
});
