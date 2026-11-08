// ISS-1070 r13: a person's reads show what production serves as observed a moment ago, saying when,
// and never a reading too old to trust; every other read is fresh.
import type { ServingReading } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { withObservedReads } from '../db/observed-reads.js';
import { withReadMemo } from '../db/read-memo.js';
import { backgroundSettled } from '../lib/background.js';
import { FRESH_MS, observedReading, TRUST_MS } from './serving-observed.js';

/** A platform answering the commit it is told, counting each time it is asked. */
function platform(commit: string) {
  const asked = { n: 0, commit };
  const read = async (): Promise<ServingReading> => {
    asked.n += 1;
    return {
      kind: 'serving',
      served: [{ commit: asked.commit, where: 'live' }],
      unread: [],
      readAt: `read ${asked.n}`,
    };
  };
  return { asked, read };
}

let keys = 0;
const fresh = () => `project-${++keys}`;
const asPerson = <T>(fn: () => Promise<T>) => withReadMemo(() => withObservedReads(fn));
const commitOf = (r: ServingReading) => (r.kind === 'serving' ? r.served[0]?.commit : r.kind);

describe("a person's reading of what is served", () => {
  it('asks the platform once for every read made at once, and not again while the reading is fresh', async () => {
    const key = fresh();
    const p = platform('aaa1111');
    let t = 1_000;
    const now = () => t;
    const first = await asPerson(() =>
      Promise.all([1, 2, 3].map(() => observedReading(key, p.read, now))),
    );
    expect(p.asked.n).toBe(1);
    expect(first.map(commitOf)).toEqual(['aaa1111', 'aaa1111', 'aaa1111']);
    t += FRESH_MS - 1;
    p.asked.commit = 'bbb2222';
    const again = await asPerson(() => observedReading(key, p.read, now));
    expect(p.asked.n).toBe(1);
    // it says when it was read: the reading's own time, never the time it is shown
    expect(again).toMatchObject({ readAt: 'read 1' });
  });

  it('shows a reading past fresh as it was read while a new one is read behind it', async () => {
    const key = fresh();
    const p = platform('aaa1111');
    let t = 1_000;
    const now = () => t;
    await asPerson(() => observedReading(key, p.read, now));
    t += FRESH_MS;
    p.asked.commit = 'bbb2222';
    const shown = await asPerson(() => observedReading(key, p.read, now));
    expect(commitOf(shown)).toBe('aaa1111');
    expect(shown).toMatchObject({ readAt: 'read 1' });
    await backgroundSettled();
    expect(p.asked.n).toBe(2);
    expect(commitOf(await asPerson(() => observedReading(key, p.read, now)))).toBe('bbb2222');
  });

  it('never shows a reading too old to trust: the person waits for a fresh one', async () => {
    const key = fresh();
    const p = platform('aaa1111');
    let t = 1_000;
    const now = () => t;
    await asPerson(() => observedReading(key, p.read, now));
    t += TRUST_MS;
    p.asked.commit = 'bbb2222';
    const shown = await asPerson(() => observedReading(key, p.read, now));
    expect(p.asked.n).toBe(2);
    expect(commitOf(shown)).toBe('bbb2222');
    expect(shown).toMatchObject({ readAt: 'read 2' });
  });

  it("reads afresh outside a person's read, and keeps what it read for the next one", async () => {
    const key = fresh();
    const p = platform('aaa1111');
    const now = () => 1_000;
    await asPerson(() => observedReading(key, p.read, now));
    p.asked.commit = 'bbb2222';
    // a release, a gate, or a read request that is not a person's attention
    expect(commitOf(await observedReading(key, p.read, now))).toBe('bbb2222');
    expect(commitOf(await withReadMemo(() => observedReading(key, p.read, now)))).toBe('bbb2222');
    expect(p.asked.n).toBe(3);
    expect(commitOf(await asPerson(() => observedReading(key, p.read, now)))).toBe('bbb2222');
    expect(p.asked.n).toBe(3);
  });
});
