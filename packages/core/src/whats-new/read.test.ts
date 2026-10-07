// What's new by time: within a day the newest version leads, a first look (no seen mark) reads the
// last 7 days and not 30, and a reader with a mark keeps the 30-day window.
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ at: null as string | null }));
vi.mock('../preferences/index.js', () => ({
  readProductState: async () => ({ value: seen.at ? { at: seen.at } : null }),
}));

import type { ChangelogRelease } from './changelog.js';
import { readWhatsNew } from './read.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const entry = (title: string, section: 'Added' | 'Fixed' = 'Added') =>
  ({ section, title, body: '', tour: null }) as never;
const release = (version: string, date: string, titles: string[]): ChangelogRelease => ({
  version,
  date,
  digests: [],
  entries: titles.map((t) => entry(t)),
});

const releases = [
  release('0.4.0-dev.96', '2026-10-07', ['ninety-six']),
  release('0.4.0-dev.9', '2026-10-07', ['nine']),
  release('0.4.0-dev.87', '2026-10-07', ['eighty-seven']),
  release('0.4.0-dev.80', '2026-10-02', ['inside-first-look']),
  release('0.4.0-dev.70', '2026-09-20', ['inside-window-only']),
];

const read = (since?: Date) =>
  readWhatsNew({ userId: 'u', since, timeZone: 'UTC', now: NOW, releases });

describe('what a day lists', () => {
  it('puts the newest version first, numbers read as numbers', async () => {
    seen.at = null;
    const feed = await read();
    const today = feed.days.find((d) => d.date === '2026-10-07');
    expect(today?.entries.map((e) => e.version)).toEqual([
      '0.4.0-dev.96',
      '0.4.0-dev.87',
      '0.4.0-dev.9',
    ]);
  });
});

describe('where the feed starts', () => {
  it('reads the last 7 days on a first look, and the header follows', async () => {
    seen.at = null;
    const feed = await read();
    expect(feed.seenAt).toBeNull();
    expect(Date.parse(feed.since)).toBe(NOW.getTime() - 7 * 86_400_000);
    expect(feed.days.flatMap((d) => d.entries.map((e) => e.title))).not.toContain(
      'inside-window-only',
    );
    expect(feed.unread).toBe(4);
  });

  it('keeps the 30-day window for a reader with a recent mark', async () => {
    seen.at = '2026-10-06T00:00:00Z';
    const feed = await read();
    expect(Date.parse(feed.since)).toBe(NOW.getTime() - 30 * 86_400_000);
    expect(feed.days.flatMap((d) => d.entries.map((e) => e.title))).toContain('inside-window-only');
  });

  it('reaches back to the mark when the reader was away longer', async () => {
    seen.at = '2026-09-01T00:00:00Z';
    const feed = await read();
    expect(Date.parse(feed.since)).toBe(Date.parse('2026-09-01T00:00:00Z'));
  });
});
