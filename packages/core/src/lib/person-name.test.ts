import { describe, expect, it } from 'vitest';
import { carriesAnAddress, personName } from './person-name.js';

// ISS-1229 r18, judge-48: a member with no display name was named by their address in the bell.
describe('what a person is called', () => {
  it('is the name they gave, trimmed', () => {
    expect(personName('  Mai ')).toBe('Mai');
  });

  it.each([null, undefined, '', '   '])(
    'is "another member" where they gave none (%j)',
    (given) => {
      expect(personName(given)).toBe('another member');
      expect(personName(given, 'start')).toBe('Another member');
    },
  );

  it('is never an address, even one set as the display name', () => {
    expect(personName('mai@example.com')).toBe('another member');
    expect(personName('Mai <mai@example.com>')).toBe('another member');
  });

  it('tells an address from a name that only holds an @', () => {
    expect(carriesAnAddress("ISS-3 is waiting for mai.tran@example.co.uk's decision")).toBe(true);
    expect(carriesAnAddress('@mai mentioned you')).toBe(false);
    expect(carriesAnAddress('Mai')).toBe(false);
  });
});
