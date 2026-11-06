// ISS-1064: the anchor audit checks what a knowledge entry's `source` names first. A planted entry
// whose source names a path this checkout does not have reads as a dead anchor; one whose file no
// longer holds the symbol it names does too; and an entry of a kind owing the three fields that holds
// none is listed as owing them (the amnesty `knowledge-entries-without-provenance`).
//
// @direct-test-of scripts/lib/knowledge-anchors.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deadSourceAnchors, owedFields, sourceAnchors } from './knowledge-anchors.mjs';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-anchors-'));
  mkdirSync(join(root, 'packages/core/src/knowledge'), { recursive: true });
  writeFileSync(
    join(root, 'packages/core/src/knowledge/upsert.ts'),
    'export async function upsertKnowledgeEntries() {}\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sourceAnchors', () => {
  it('reads paths with their symbols, keys and URLs, in order, and leaves prose out', () => {
    expect(
      sourceAnchors(
        '`packages/core/src/knowledge/upsert.ts:upsertKnowledgeEntries`, ISS-1064; REQ-50 (owner ruling 2026-11-01) https://example.com/a',
      ),
    ).toEqual([
      {
        kind: 'path',
        anchor: 'packages/core/src/knowledge/upsert.ts',
        symbol: 'upsertKnowledgeEntries',
      },
      { kind: 'key', anchor: 'ISS-1064' },
      { kind: 'key', anchor: 'REQ-50' },
      { kind: 'url', anchor: 'https://example.com/a' },
    ]);
  });

  it('reads nothing from a missing or empty source', () => {
    expect(sourceAnchors(null)).toEqual([]);
    expect(sourceAnchors(undefined)).toEqual([]);
    expect(sourceAnchors('')).toEqual([]);
  });
});

describe('deadSourceAnchors (criterion 3)', () => {
  it('reads a planted source naming a path that does not exist as a dead anchor', () => {
    const planted = 'packages/core/src/zz-iss1064-not-real/plant.ts:plantedSymbol, ISS-1064';
    expect(deadSourceAnchors(planted, root)).toEqual([
      { kind: 'source-path', anchor: 'packages/core/src/zz-iss1064-not-real/plant.ts' },
    ]);
  });

  it('reads a symbol its file no longer holds as dead, and a line number in place of one', () => {
    expect(
      deadSourceAnchors(
        'packages/core/src/knowledge/upsert.ts:upsertGone, packages/core/src/knowledge/upsert.ts:12',
        root,
      ),
    ).toEqual([
      { kind: 'source-symbol', anchor: 'packages/core/src/knowledge/upsert.ts:upsertGone' },
      { kind: 'source-line', anchor: 'packages/core/src/knowledge/upsert.ts:12' },
    ]);
  });

  it('finds nothing dead in a source whose file holds its symbol, keys and URLs never fetched', () => {
    expect(
      deadSourceAnchors(
        'packages/core/src/knowledge/upsert.ts:upsertKnowledgeEntries, ISS-1064, https://example.com',
        root,
      ),
    ).toEqual([]);
  });

  it('leaves a path git ignores out, as the body check does', () => {
    expect(deadSourceAnchors('packages/core/dist/x.js', root, { ignored: () => true })).toEqual([]);
  });
});

describe('owedFields', () => {
  it('lists the fields a reference, guide, workflow or rule leaves out', () => {
    expect(owedFields({ kind: 'guide' })).toEqual(['source', 'scope', 'recheckWhen']);
    expect(owedFields({ kind: 'rule', source: 'ISS-1', scope: ' ', recheckWhen: 'x' })).toEqual([
      'scope',
    ]);
    expect(owedFields({ kind: 'reference', source: 'a', scope: 'b', recheckWhen: 'c' })).toEqual(
      [],
    );
  });

  it('owes nothing for a lesson, overview, scenario or glossary', () => {
    for (const kind of ['lesson', 'overview', 'scenario', 'glossary'])
      expect(owedFields({ kind }), kind).toEqual([]);
  });
});
