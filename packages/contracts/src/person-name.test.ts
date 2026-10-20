import { describe, expect, it } from 'vitest';
import {
  carriesAnAddress,
  displayNameRefusal,
  givenName,
  personChoice,
  personInitials,
  personName,
} from './person-name.js';

// ISS-1229 r21: the one name helper web and core both read.
describe('what a person is called', () => {
  it('is the name they gave, trimmed', () => {
    expect(personName('  Mai Tran ')).toBe('Mai Tran');
    expect(givenName(' Mai ')).toBe('Mai');
  });

  it.each([null, undefined, '', '   ', 'mai@example.com', 'Mai <mai@example.com>'])(
    'is "another member" where no name was given or the name holds an address (%j)',
    (given) => {
      expect(givenName(given)).toBeNull();
      expect(personName(given)).toBe('another member');
      expect(personName(given, 'start')).toBe('Another member');
    },
  );

  it('takes initials from the name, else from "another member", never from an address', () => {
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
    const [one, two] = [personChoice(null, 'lan@example.com'), personChoice(' ', ' kim@example.com ')];
    expect([one.label, two.label]).toEqual(['Another member', 'Another member']);
    expect([one.detail, two.detail]).toEqual(['lan@example.com', 'kim@example.com']);
    expect(personChoice(' Mai Tran ', 'mai@example.com')).toEqual({ label: 'Mai Tran', detail: 'mai@example.com' });
  });

  // ISS-1229 r22: a label core already served is placed again where the web's sentence puts it.
  it.each(['Another member', 'another member', ' ANOTHER MEMBER '])(
    'reads its own fallback words (%j) as no name, so a served label goes lower-case mid-sentence',
    (served) => {
      expect(givenName(served)).toBeNull();
      expect(personName(served)).toBe('another member');
      expect(personName(served, 'start')).toBe('Another member');
    },
  );

  it('places a served name the same at either position', () => {
    expect(personName(personName('Mai Tran', 'start'))).toBe('Mai Tran');
    expect(personName(personName(null, 'start'))).toBe('another member');
  });
});

describe('a display name holding an address', () => {
  it.each(['mai@example.com', ' mai@example.com ', 'Mai <mai@example.com>'])(
    'is refused with one sentence saying why (%j)',
    (typed) => {
      const why = displayNameRefusal(typed);
      expect(why).toMatch(/^A display name cannot hold an email address/);
      expect(why).toMatch(/"Another member"/);
      expect(why).toMatch(/\.$/);
    },
  );

  it.each(['Mai Tran', '@mai', ' ', ''])('is not refused where it holds none (%j)', (typed) => {
    expect(displayNameRefusal(typed)).toBeNull();
  });
});
