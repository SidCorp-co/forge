import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNKED_SOURCES,
  chunkText,
  contextPrefix,
  estimateChunks,
  isChunkedSource,
  SINGLE_CHUNK_BELOW,
} from './chunker.js';

const sentence = (i: number) => `Sentence number ${i} carries a fact about widget ${i}.`;
function body(chars: number): string {
  const paragraphs: string[] = [];
  let i = 0;
  while (paragraphs.join('\n\n').length < chars) {
    paragraphs.push([sentence(i), sentence(i + 1), sentence(i + 2)].join(' '));
    i += 3;
  }
  return paragraphs.join('\n\n').slice(0, chars);
}

describe('chunkText', () => {
  it('keeps a body under the single-chunk threshold whole', () => {
    const text = body(900);
    expect(text.length).toBeLessThan(SINGLE_CHUNK_BELOW);
    expect(chunkText(text)).toEqual([text]);
  });

  it('splits a 5,000-character body into chunks of at most CHUNK_MAX_CHARS', () => {
    const chunks = chunkText(body(5000));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it('opens every chunk after the first with the tail of the one before, so a seam sentence is in two neighbours', () => {
    const chunks = chunkText(body(5000));
    for (let i = 1; i < chunks.length; i++) {
      const opening = (chunks[i] ?? '').slice(0, 60);
      expect(opening.length).toBe(60);
      expect(chunks[i - 1]?.includes(opening)).toBe(true);
      const overlapLine = (chunks[i] ?? '').indexOf('\n');
      expect(overlapLine).toBeGreaterThan(0);
      expect(overlapLine).toBeLessThan(CHUNK_OVERLAP_CHARS);
    }
  });

  it('loses no sentence: every sentence of the body appears in some chunk', () => {
    const text = body(5000);
    const chunks = chunkText(text);
    for (const s of text.split(/\n\n| (?=Sentence)/).filter((x) => x.endsWith('.'))) {
      expect(chunks.some((c) => c.includes(s))).toBe(true);
    }
  });

  it('hard-cuts a single run of text with no paragraph or sentence break', () => {
    const chunks = chunkText('x'.repeat(4000));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    expect(chunks.join('').length).toBeGreaterThanOrEqual(4000);
  });
});

describe('contextPrefix', () => {
  it('names an issue by its ISS-n, first line, priority and category', () => {
    expect(
      contextPrefix({
        source: 'issue',
        sourceRef: 'uuid',
        textContent: 'Login times out\n\nLong body',
        metadata: { priority: 'high', category: 'bug' },
        issueLabel: 'ISS-42',
      }),
    ).toBe('Issue ISS-42 "Login times out" · high · bug');
  });
  it('falls back to the sourceRef when no label was found and skips absent metadata', () => {
    expect(
      contextPrefix({ source: 'issue', sourceRef: 'uuid', textContent: 'T', metadata: {} }),
    ).toBe('Issue uuid "T"');
  });
  it('names knowledge by slug and category, and the other sources by source and ref', () => {
    expect(
      contextPrefix({
        source: 'knowledge',
        sourceRef: 'deploy-order',
        textContent: 'x',
        metadata: { category: 'convention' },
      }),
    ).toBe('Knowledge deploy-order (convention)');
    expect(
      contextPrefix({ source: 'decision', sourceRef: 'adr-7', textContent: 'x', metadata: {} }),
    ).toBe('Decision adr-7');
  });
});

describe('scope and estimate', () => {
  it('CHUNKED_SOURCES is the owner set and comment/job are outside it', () => {
    expect([...CHUNKED_SOURCES]).toEqual(['issue', 'note', 'knowledge', 'decision', 'policy']);
    expect(isChunkedSource('comment')).toBe(false);
    expect(isChunkedSource('job')).toBe(false);
    expect(isChunkedSource('note')).toBe(true);
  });
  it('estimateChunks mirrors the chunker: one below the threshold, then one per 1,000-character stride', () => {
    expect(estimateChunks(0)).toBe(0);
    expect(estimateChunks(900)).toBe(1);
    expect(estimateChunks(1499)).toBe(1);
    expect(estimateChunks(1500)).toBe(2);
    expect(estimateChunks(5000)).toBe(5);
  });
});
