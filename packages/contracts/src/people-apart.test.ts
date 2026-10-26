import { describe, expect, it } from 'vitest';
import { addedApart, compareAdded, listedAs } from './people-apart.js';

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

// ISS-1229 r44, judge-124: two readers of one room meant different people by "the first", because each
// left themself out of the people told apart.
describe('addedApart — the same person behind the same words for every reader', () => {
  const minute = '2026-10-03T09:00:';
  const a = person('a', null, `${minute}01Z`);
  const b = person('b', null, `${minute}02Z`);
  const c = person('c', null, `${minute}03Z`);
  const room = [a, b, c];

  it('names each unnamed person by their place among everyone, whoever reads', () => {
    for (const reader of ['a', 'b', 'c', 'outsider']) {
      const words = Object.fromEntries(room.map((p) => [p.userId, addedApart(p, room, reader)]));
      for (const [id, place] of [['a', 'first'], ['b', 'second'], ['c', 'third']] as const) {
        expect(words[id], `${reader} reading ${id}`).toEqual(
          id === reader ? null : expect.stringMatching(new RegExp(`, the ${place}$`)),
        );
      }
    }
  });

  it('keeps the reader as "You" with nothing beside it', () => {
    expect(listedAs(a, room, 'a')).toBe('You');
  });

  it('counts the reader among the people it tells apart, adding nothing where only the reader reads alike', () => {
    const pair = [a, person('b', null, `${minute}02Z`)];
    expect(addedApart(pair[1] as never, pair, 'a')).toBeNull();
    expect(addedApart(pair[1] as never, pair, 'outsider')).toMatch(/, the second$/);
  });
});

// ISS-1229 r45, judge-129: a room's people are added in one transaction, so they share one moment, and
// the tie fell to each row's random id: the person who opened the room could read as "the second".
describe('addedApart — people added at one moment', () => {
  const at = '2026-10-26T09:00:00Z';
  const served = (key: string, place: number) => ({ userId: `u-${key}`, displayName: null, addedAt: at, key, place });
  // Row ids that sort against the order the room serves them in.
  const opener = served('z-row', 0);
  const second = served('m-row', 1);
  const third = served('a-row', 2);
  const room = [third, opener, second];

  it('takes the order the room serves them in before the row id', () => {
    expect(addedApart(opener, room, 'outsider')).toMatch(/, the first$/);
    expect(addedApart(second, room, 'outsider')).toMatch(/, the second$/);
    expect(addedApart(third, room, 'outsider')).toMatch(/, the third$/);
  });

  it('sorts by that same order wherever a list of people is ordered', () => {
    expect([...room].sort(compareAdded).map((p) => p.key)).toEqual(['z-row', 'm-row', 'a-row']);
  });

  it('falls back to the row id where nothing serves an order', () => {
    const { place: _a, ...a } = served('b-row', 0);
    const { place: _b, ...b } = served('a-row', 1);
    expect([a, b].sort(compareAdded).map((p) => p.key)).toEqual(['a-row', 'b-row']);
  });
});
