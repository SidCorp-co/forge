// Pure passage splitter for the chunked memory model (retrieval v3 phase 2,
// ISS-906). Paragraphs first, then sentences, then a hard cut; each chunk
// carries the tail of its predecessor so a fact straddling a seam is still
// inside one passage. No database, no model: the write path, the backfill,
// the reindex job and the estimate all call this and nothing else decides
// what a chunk is.

import type { MemorySource } from '../db/schema.js';

// cm:guard CHUNKED_SOURCES is the ONE place the owner's scope decision (2026-09-04: `comment` and `job` mirrors stay flat) lives — the write path, the estimate and the reindex job all filter on it, so a source added here is chunked everywhere at once and a source named anywhere else is a second copy that will drift
export const CHUNKED_SOURCES: readonly MemorySource[] = [
  'issue',
  'note',
  'knowledge',
  'decision',
  'policy',
];

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 200;
export const SINGLE_CHUNK_BELOW = 1500;
/** The most a chunk can carry: a full target piece plus the overlap prepended from its predecessor. */
export const CHUNK_MAX_CHARS = CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS;

export function isChunkedSource(source: string): source is MemorySource {
  return (CHUNKED_SOURCES as readonly string[]).includes(source);
}

function splitLong(piece: string, limit: number): string[] {
  if (piece.length <= limit) return [piece];
  const sentences = piece.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const parts = sentence.length > limit ? hardCut(sentence, limit) : [sentence];
    for (const part of parts) {
      if (current && current.length + 1 + part.length > limit) {
        out.push(current);
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function hardCut(text: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

function pieces(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    for (const part of splitLong(paragraph, CHUNK_TARGET_CHARS)) {
      if (current && current.length + 2 + part.length > CHUNK_TARGET_CHARS) {
        out.push(current);
        current = part;
      } else {
        current = current ? `${current}\n\n${part}` : part;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

// cm:guard the tail is one character short of CHUNK_OVERLAP_CHARS because the joining newline counts — a full 200 + '\n' + a full 1200 piece is 1401, one over the CHUNK_MAX_CHARS the proposal and the estimate both promise
function overlapTail(previous: string): string {
  const budget = CHUNK_OVERLAP_CHARS - 1;
  if (previous.length <= budget) return previous;
  const tail = previous.slice(-budget);
  const firstSpace = tail.indexOf(' ');
  return firstSpace > 0 && firstSpace < budget / 2 ? tail.slice(firstSpace + 1) : tail;
}

/** The passages of one document, each at most CHUNK_MAX_CHARS, each after the first opening with the tail of the one before. */
export function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length < SINGLE_CHUNK_BELOW) return [trimmed];
  const parts = pieces(trimmed);
  return parts.map((part, i) => {
    const previous = parts[i - 1];
    return i === 0 || previous === undefined ? part : `${overlapTail(previous)}\n${part}`;
  });
}

export interface PrefixRow {
  source: MemorySource;
  sourceRef: string;
  textContent: string;
  metadata: unknown;
  /** `ISS-<n>` for an issue row, looked up by the caller; absent for every other source. */
  issueLabel?: string | undefined;
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim().slice(0, 120);
}

function meta(row: PrefixRow, key: string): string | undefined {
  const md = (row.metadata ?? {}) as Record<string, unknown>;
  const v = md[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** What is prepended to every chunk before embedding, so a passage carries where it came from. */
export function contextPrefix(row: PrefixRow): string {
  if (row.source === 'issue') {
    const parts = [
      `Issue ${row.issueLabel ?? row.sourceRef} "${firstLine(row.textContent)}"`,
      meta(row, 'priority'),
      meta(row, 'category'),
    ].filter(Boolean);
    return parts.join(' · ');
  }
  if (row.source === 'knowledge') {
    const category = meta(row, 'category');
    return `Knowledge ${row.sourceRef}${category ? ` (${category})` : ''}`;
  }
  return `${row.source[0]?.toUpperCase()}${row.source.slice(1)} ${row.sourceRef}`;
}

/** How many chunks a body of `chars` characters produces, for the estimate the owner sees before a flip. */
export function estimateChunks(chars: number): number {
  if (chars <= 0) return 0;
  if (chars < SINGLE_CHUNK_BELOW) return 1;
  return Math.ceil(chars / (CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS));
}
