import { describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('../logger.js', () => ({ logger: { warn } }));

const { carriesAnAddress, personName } = await import('./person-name.js');

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

  // ISS-1229 r19: the person slot is the one guarded slot of a title, and it says when it acts.
  it('logs an address read in the person slot, naming no address, and nothing for a name', () => {
    warn.mockClear();
    personName('Mai');
    personName(null);
    expect(warn).not.toHaveBeenCalled();
    personName('Another member', 'inside');
    expect(warn).not.toHaveBeenCalled();
    personName('mai@example.com');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('mai@example.com');
  });

  it('tells an address from a name that only holds an @', () => {
    expect(carriesAnAddress("ISS-3 is waiting for mai.tran@example.co.uk's decision")).toBe(true);
    expect(carriesAnAddress('@mai mentioned you')).toBe(false);
    expect(carriesAnAddress('Mai')).toBe(false);
  });
});
