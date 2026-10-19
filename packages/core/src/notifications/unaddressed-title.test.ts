import { describe, expect, it, vi } from 'vitest';

const people = [
  { email: 'Mai@Example.com', displayName: 'Mai' },
  { email: 'lan@example.com', displayName: null },
  { email: 'a@example.test', displayName: 'Ana' },
  { email: 'ba@example.test', displayName: 'Bao' },
];
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => people }) }) },
}));
vi.mock('../logger.js', () => ({ logger: { warn: () => undefined } }));

const { unaddressedTitle } = await import('./unaddressed-title.js');

// ISS-1229 r18, judge-48: "ISS-3 is waiting for <address>'s decision" was stored, and kept for good.
describe('a notice title at the delivery door', () => {
  it('keeps a title that carries no address as it is', async () => {
    expect(await unaddressedTitle('ISS-3 moved to Testing')).toBe('ISS-3 moved to Testing');
  });

  it("reads a person's address as their display name, whatever its case", async () => {
    expect(await unaddressedTitle("ISS-3 is waiting for mai@example.com's decision — Board")).toBe(
      "ISS-3 is waiting for Mai's decision — Board",
    );
  });

  it('reads an unnamed person, and an address that is nobody, as another member', async () => {
    expect(await unaddressedTitle('lan@example.com invited you to Board as member')).toBe(
      'Another member invited you to Board as member',
    );
    expect(await unaddressedTitle('ISS-4 is waiting for ghost@example.org')).toBe(
      'ISS-4 is waiting for another member',
    );
  });

  it('reads an address that sits inside another as its own person only where it stands alone', async () => {
    expect(await unaddressedTitle('a@example.test and ba@example.test')).toBe('Ana and Bao');
  });
});
