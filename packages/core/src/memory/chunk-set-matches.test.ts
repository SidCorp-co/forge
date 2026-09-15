/**
 * ISS-1024 — `chunkSetMatches` decides whether the live chunk set already IS the set this write
 * would publish, so an unchanged document is not re-chunked and re-embedded.
 *
 * It compares what was EMBEDDED and not the fields that string was derived from: every row carries
 * both halves of its embed input (`context_prefix` and `text_content`), and `chunkAndPublish`
 * embeds exactly `prefix + "\n" + passage`. A comparison over `memories.text_content` alone would
 * leave a set whose prefix moved with a metadata edit, and a stale chunk vector ranks every later
 * search wrong with nothing going red.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../embeddings/index.js', () => ({ embedBatch: vi.fn() }));

const { chunkSetMatches } = await import('./chunk-writer.js');

type Row = {
  chunkIndex: number;
  textContent: string;
  contextPrefix: string;
  embedded: boolean;
};

let rows: Row[] = [];
const where = vi.fn();
const tx = {
  select: () => ({
    from: () => ({
      where: (w: unknown) => {
        where(w);
        return { orderBy: async () => rows };
      },
    }),
  }),
} as unknown as Parameters<typeof chunkSetMatches>[0];

const PREFIX = 'Issue ISS-7 "the runner claims a slot" · high · bug';
const PASSAGES = ['first passage', 'second passage'];
const parent = { id: 'm-1', chunkGeneration: 4, chunkedAt: new Date(0) };
const row = (i: number, over: Partial<Row> = {}): Row => ({
  chunkIndex: i,
  textContent: PASSAGES[i] as string,
  contextPrefix: PREFIX,
  embedded: true,
  ...over,
});

beforeEach(() => {
  where.mockClear();
  rows = [row(0), row(1)];
});

describe('chunkSetMatches', () => {
  it('matches a published set whose passages, prefix and vectors are all what this write would build', async () => {
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(true);
  });

  it('refuses a set whose stored context prefix is not the one computed now', async () => {
    rows = [
      row(0, { contextPrefix: 'Issue ISS-7 "the runner claims a slot" · low · bug' }),
      row(1),
    ];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });

  it('refuses a set whose stored passage text is not the one chunkText produces now', async () => {
    rows = [row(0), row(1, { textContent: 'second passage, as it used to read' })];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });

  it('refuses a set holding a chunk with no vector', async () => {
    rows = [row(0), row(1, { embedded: false })];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });

  it('refuses a set with fewer chunks than the write would publish', async () => {
    rows = [row(0)];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });

  it('refuses a set with more chunks than the write would publish', async () => {
    rows = [row(0), row(1), { ...row(0), chunkIndex: 2, textContent: 'third' }];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });

  // cm:guard `chunked_at IS NULL` is a set that was invalidated and never republished — the search
  // arm joins on it, so those rows are already unreachable and the write owes a rebuild
  it('refuses a parent whose chunked_at is null, whatever the rows say', async () => {
    expect(await chunkSetMatches(tx, { ...parent, chunkedAt: null }, PREFIX, PASSAGES)).toBe(false);
  });

  it('reads no row at all for an unpublished parent', async () => {
    await chunkSetMatches(tx, { ...parent, chunkedAt: null }, PREFIX, PASSAGES);
    expect(where).not.toHaveBeenCalled();
  });

  it('refuses a set whose chunk indexes are not 0..n-1 in order', async () => {
    rows = [row(0), { ...row(1), chunkIndex: 5 }];
    expect(await chunkSetMatches(tx, parent, PREFIX, PASSAGES)).toBe(false);
  });
});
