import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { waitingParkTitle } = await import('./waiting-titles.js');

// ISS-1229 r16, the master's ruling on criterion 98: "you" only where the reader owes the park.
describe('a waiting park told to one reader', () => {
  const base = { ref: 'ISS-2', projectName: 'Board' };

  it.each([
    ['needs_decision', 'ISS-2 is waiting for your decision — Board'],
    ['needs_resource', 'ISS-2 is waiting for something only you can supply — Board'],
    [null, 'ISS-2 is waiting for you — Board'],
  ])('says "you" to the one who owes a %s park', (waitingKind, title) => {
    expect(waitingParkTitle({ ...base, waitingKind, owedBy: { you: true } })).toBe(title);
  });

  it.each([
    ['needs_decision', "ISS-2 is waiting for Mai's decision — Board"],
    ['needs_resource', 'ISS-2 is waiting for something only Mai can supply — Board'],
    [null, 'ISS-2 is waiting for Mai — Board'],
  ])('names who owes a %s park to anyone else, never "you"', (waitingKind, title) => {
    const said = waitingParkTitle({ ...base, waitingKind, owedBy: { you: false, name: 'Mai' } });
    expect(said).toBe(title);
    expect(said).not.toMatch(/\byour?\b/);
  });
});
