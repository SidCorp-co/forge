import { describe, expect, it } from 'vitest';
import {
  carriesAnAddress,
  displayNameRefusal,
  givenName,
  personChoice,
  personInitials,
  personName,
  READER_INITIAL,
  readerInitials,
  readerName,
} from './person-name.js';

// ISS-1229 r21: the one name helper web and core both read.
describe('what a person is called', () => {
  it('is the name they gave, trimmed', () => {
    expect(personName('  Mai Tran ')).toBe('Mai Tran');
    expect(givenName(' Mai ')).toBe('Mai');
  });

  it.each([null, undefined, '', '   ', 'mai@example.com', 'Mai <mai@example.com>'])(
    'is "a member" where no name was given or the name holds an address (%j)',
    (given) => {
      expect(givenName(given)).toBeNull();
      expect(personName(given)).toBe('a member');
      expect(personName(given, 'start')).toBe('A member');
    },
  );

  it('takes initials from the name, else from "a member", never from an address', () => {
    expect(personInitials('Mai Tran')).toBe('MT');
    expect(personInitials('mai')).toBe('MA');
    expect(personInitials(null)).toBe('AM');
    expect(personInitials('lan.pham@example.com')).toBe('AM');
  });

  it('tells an address from a name that only holds an @', () => {
    expect(carriesAnAddress('@mai mentioned you')).toBe(false);
    expect(carriesAnAddress('mai.tran@example.co.uk')).toBe(true);
  });

  it('offers a person in a picker by name, with the address beside it to tell two alike apart', () => {
    const [one, two] = [
      personChoice(null, 'lan@example.com'),
      personChoice(' ', ' kim@example.com '),
    ];
    expect([one.label, two.label]).toEqual(['A member', 'A member']);
    expect([one.detail, two.detail]).toEqual(['lan@example.com', 'kim@example.com']);
    expect(personChoice(' Mai Tran ', 'mai@example.com')).toEqual({
      label: 'Mai Tran',
      detail: 'mai@example.com',
    });
  });

  // ISS-1229 r22: a label core already served is placed again where the web's sentence puts it.
  it.each(['A member', 'a member', ' A MEMBER '])(
    'reads its own fallback words (%j) as no name, so a served label goes lower-case mid-sentence',
    (served) => {
      expect(givenName(served)).toBeNull();
      expect(personName(served)).toBe('a member');
      expect(personName(served, 'start')).toBe('A member');
    },
  );

  it('places a served name the same at either position', () => {
    expect(personName(personName('Mai Tran', 'start'))).toBe('Mai Tran');
    expect(personName(personName(null, 'start'))).toBe('a member');
  });
});

describe('a display name holding an address', () => {
  it.each(['mai@example.com', ' mai@example.com ', 'Mai <mai@example.com>'])(
    'is refused with one sentence saying why (%j)',
    (typed) => {
      const why = displayNameRefusal(typed);
      expect(why).toMatch(/^A display name cannot hold an email address/);
      expect(why).toMatch(/"A member"/);
      expect(why).toMatch(/\.$/);
    },
  );

  it.each(['Mai Tran', '@mai', ' ', ''])('is not refused where it holds none (%j)', (typed) => {
    expect(displayNameRefusal(typed)).toBeNull();
  });
});

// ISS-1229 r24: the reader reads "You" wherever a person is named to them, and their own avatar
// never wears the initials of an unnamed member.
describe('the reader', () => {
  it('reads "You" for themself, at a sentence start and inside one', () => {
    expect(readerName('u1', 'u1', 'Mai Tran')).toBe('You');
    expect(readerName('u1', 'u1', null, 'inside')).toBe('you');
  });

  it('reads anyone else as personName names them, and so does a page with no reader', () => {
    expect(readerName('u2', 'u1', 'Mai Tran')).toBe('Mai Tran');
    expect(readerName('u2', 'u1', null)).toBe('A member');
    expect(readerName('u1', null, null, 'inside')).toBe('a member');
    expect(readerName(null, null, 'Mai')).toBe('Mai');
  });

  it('takes their own initials from their name, and never "AM" where they gave none', () => {
    expect(readerInitials('u1', 'u1', 'Mai Tran')).toBe('MT');
    expect(readerInitials('u1', 'u1', null)).toBe(READER_INITIAL);
    expect(readerInitials('u1', 'u1', 'A member')).toBe(READER_INITIAL);
    expect(READER_INITIAL).not.toBe('AM');
  });

  it("leaves everyone else's initials as personInitials takes them", () => {
    expect(readerInitials('u2', 'u1', null)).toBe('AM');
    expect(readerInitials('u2', 'u1', 'Lan Pham')).toBe('LP');
  });
});
