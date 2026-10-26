import { describe, expect, it } from 'vitest';
import { addedApart, listedAs } from './people-apart.js';

const person = (userId: string, displayName: string | null, addedAt: string) => ({
  userId,
  displayName,
  addedAt,
});

// ISS-1421 r29: core names a nameless owner by this, so a refusal reads as the Members row does.
describe('listedAs — a person as a Members list row names them', () => {
  it('names a person by their own name, and alone they need nothing beside it', () => {
    const ana = person('u1', 'Ana', '2026-10-03T09:00:00Z');
    expect(listedAs(ana, [ana], 'reader')).toBe('Ana');
  });

  it('calls one unnamed person "Another member" with nothing beside it', () => {
    const one = person('u1', null, '2026-10-03T09:00:00Z');
    const named = person('u2', 'Ana', '2026-10-01T09:00:00Z');
    expect(listedAs(one, [one, named], 'reader')).toBe('Another member');
  });

  it('tells two unnamed people apart by the day each was added', () => {
    const first = person('u1', null, '2026-10-03T09:00:00Z');
    const second = person('u2', null, '2026-10-04T09:00:00Z');
    expect(listedAs(first, [first, second], 'reader')).toBe('Another member (added 3 Oct 2026)');
    expect(addedApart(second, [first, second], 'reader')).toBe('added 4 Oct 2026');
  });

  it('calls the reader "You", whatever name they set', () => {
    const me = person('reader', null, '2026-10-03T09:00:00Z');
    expect(listedAs(me, [me], 'reader')).toBe('You');
  });
});
