import { describe, expect, it } from 'vitest';
import { carriesAnAddress, givenName, personChoice, personInitials, personName } from './person-name.js';

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
});
