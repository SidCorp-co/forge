// ISS-1064: a reference, guide, workflow or rule, and every org entry, is written with what it rests
// on, where it applies and when it needs re-checking, or refused naming each field left out.

import {
  KNOWLEDGE_PROVENANCE_FIELD_SHAPES,
  KNOWLEDGE_PROVENANCE_SHAPE,
} from '@forge/contracts/knowledge';
import { describe, expect, it } from 'vitest';
import { thrownEnvelope } from '../lib/refusal.js';
import {
  entryProvenanceRefusal,
  owesProvenance,
  provenanceOf,
  provenanceRefusal,
} from './provenance.js';

const FULL = {
  source: 'packages/core/src/knowledge/upsert.ts:upsertKnowledgeEntries',
  scope: 'every knowledge write',
  recheckWhen: 'upsertKnowledgeEntries moves',
};

describe('which kinds owe the three fields', () => {
  it('a reference, guide, workflow and rule owe them; a lesson, overview, scenario and glossary do not', () => {
    for (const kind of ['reference', 'guide', 'workflow', 'rule'])
      expect(owesProvenance(kind), kind).toBe(true);
    for (const kind of ['lesson', 'overview', 'scenario', 'glossary'])
      expect(owesProvenance(kind), kind).toBe(false);
  });
});

describe('entryProvenanceRefusal', () => {
  it('refuses a reference with none, one refusal per field at its path, the sentence naming each and the shape', () => {
    const err = entryProvenanceRefusal({ slug: 'deploy-notes', kind: 'reference' });
    expect(err).not.toBeNull();
    const envelope = thrownEnvelope(err as NonNullable<typeof err>);
    expect(envelope.error.refusals.map((r) => [r.code, r.path])).toEqual([
      ['KNOWLEDGE_PROVENANCE_MISSING', '/source'],
      ['KNOWLEDGE_PROVENANCE_MISSING', '/scope'],
      ['KNOWLEDGE_PROVENANCE_MISSING', '/recheckWhen'],
    ]);
    expect(envelope.detail).toContain(
      '`deploy-notes` is a reference and names no `source`, `scope`, `recheckWhen`',
    );
    expect(envelope.detail).toContain(KNOWLEDGE_PROVENANCE_SHAPE);
    // the message a client prints carries each field's own shape
    for (const f of ['source', 'scope', 'recheckWhen'] as const)
      expect(envelope.message).toContain(KNOWLEDGE_PROVENANCE_FIELD_SHAPES[f]);
  });

  it('names only the field left out, a null or a blank counting as left out', () => {
    const nulled = entryProvenanceRefusal({ slug: 'g', kind: 'guide', ...FULL, scope: null });
    expect(nulled?.refusals.map((r) => r.path)).toEqual(['/scope']);
    const blank = entryProvenanceRefusal({ slug: 'g', kind: 'rule', ...FULL, recheckWhen: ' \n ' });
    expect(blank?.refusals.map((r) => r.path)).toEqual(['/recheckWhen']);
  });

  it('takes a write of a kind owing them that carries all three', () => {
    for (const kind of ['reference', 'guide', 'workflow', 'rule'])
      expect(entryProvenanceRefusal({ slug: 'g', kind, ...FULL }), kind).toBeNull();
  });

  it('takes a lesson, overview, scenario or glossary with none', () => {
    for (const kind of ['lesson', 'overview', 'scenario', 'glossary'])
      expect(entryProvenanceRefusal({ slug: 'g', kind }), kind).toBeNull();
  });
});

describe('provenanceRefusal for an org entry', () => {
  it('owes the three whatever the entry, naming it as the org entry', () => {
    const err = provenanceRefusal('org entry `voice`', { source: FULL.source });
    expect(err?.refusals.map((r) => r.path)).toEqual(['/scope', '/recheckWhen']);
    expect(err?.message).toContain('KNOWLEDGE_PROVENANCE_MISSING');
    expect(provenanceRefusal('org entry `voice`', FULL)).toBeNull();
  });
});

describe('provenanceOf', () => {
  it('stores each trimmed, and null where nothing or only whitespace was sent', () => {
    expect(provenanceOf({ source: '  a.ts:b  ', scope: '', recheckWhen: undefined })).toEqual({
      source: 'a.ts:b',
      scope: null,
      recheckWhen: null,
    });
  });
});
