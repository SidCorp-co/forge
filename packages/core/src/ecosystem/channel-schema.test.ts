import { describe, expect, it } from 'vitest';
import { doc, holdWorld } from './channel.fixture.js';
import { holdRefusals, parseChannelDocument, parseHold } from './channel-rules.js';
import { clone, type Doc, emittedAccepts } from './ecosystem.fixture.js';

const codes = (refusals: { code: string }[]) => refusals.map((r) => r.code);
const cn = () => doc('FP-CN-12.document.json');
const ack = () => doc('FP-ACK-7.document.json');
const dec = () => doc('FP-DEC-9.document.json');
const hold = () => doc('FP-CR-3.hold.json');

function holdOf(h: Doc, holds: import('./channel-schema.js').ThreadHold[] = []) {
  const parsed = parseHold(h);
  if (!parsed.ok) return parsed.refusals;
  return holdRefusals(parsed.value, holdWorld({ holds }));
}

const shapePlants: [string, string, string, () => Doc][] = [
  ['a type outside the five', 'DOCUMENT_TYPE_UNKNOWN', '/type', () => ({ ...cn(), type: 'memo' })],
  [
    'a free field in a change notice',
    'UNKNOWN_KEY',
    '/body/chat',
    () => {
      const d = cn();
      d.body.chat = 'hi';
      return d;
    },
  ],
  [
    'a state not in the lifecycle',
    'SCHEMA_VIOLATION',
    '/state',
    () => ({ ...cn(), state: 'sent' }),
  ],
  ['published without a number', 'SCHEMA_VIOLATION', '/number', () => ({ ...cn(), number: null })],
  [
    'a change notice without migration',
    'SCHEMA_VIOLATION',
    '/body/migration',
    () => {
      const d = cn();
      delete d.body.migration;
      return d;
    },
  ],
  [
    'will-adapt without adaptBy',
    'SCHEMA_VIOLATION',
    '/body/adaptBy',
    () => ({ ...ack(), body: { disposition: 'will-adapt' } }),
  ],
  [
    'blocked without blockedOn',
    'SCHEMA_VIOLATION',
    '/body/blockedOn',
    () => ({ ...ack(), body: { disposition: 'blocked' } }),
  ],
  [
    'no-impact without evidence',
    'SCHEMA_VIOLATION',
    '/body/evidence',
    () => ({ ...ack(), body: { disposition: 'no-impact' } }),
  ],
  [
    'an acknowledgement answering nothing',
    'SCHEMA_VIOLATION',
    '/inReplyTo',
    () => {
      const d = ack();
      delete d.inReplyTo;
      return d;
    },
  ],
  [
    'accepted without plannedOn',
    'SCHEMA_VIOLATION',
    '/body/plannedOn',
    () => ({ ...dec(), body: { disposition: 'accepted', reason: 'ok' } }),
  ],
  [
    'deferred without revisitOn',
    'SCHEMA_VIOLATION',
    '/body/revisitOn',
    () => ({ ...dec(), body: { disposition: 'deferred', reason: 'later' } }),
  ],
  [
    'submitted without a reserved number',
    'SCHEMA_VIOLATION',
    '/number',
    () => ({ ...cn(), state: 'submitted', number: null, gate: { mode: 'approve' } }),
  ],
  [
    'a number with an unknown type code',
    'SCHEMA_VIOLATION',
    '/number',
    () => ({ ...cn(), number: 'FP-MEMO-1' }),
  ],
  [
    'returned in publish mode',
    'SCHEMA_VIOLATION',
    '/gate/mode',
    () => ({
      ...cn(),
      state: 'returned',
      gate: { mode: 'publish', decision: 'returned', note: 'x' },
    }),
  ],
  [
    "an agent claims to write through a person's chat",
    'SCHEMA_VIOLATION',
    '/authoredBy/via',
    () => ({ ...cn(), authoredBy: { kind: 'agent', id: 'master-forge-dev', via: 'assistant' } }),
  ],
];

describe('a document whose shape is wrong is refused by name, by zod and by the emitted schema', () => {
  it.each(shapePlants)('%s → %s at %s', (_name, code, path, plant) => {
    const d = plant();
    const parsed = parseChannelDocument(d);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals.map((r) => `${r.code} ${r.path}`)).toContain(`${code} ${path}`);
    expect(emittedAccepts(clone(d))).toBe(false);
  });
});

describe('a hold whose shape is wrong is refused by name', () => {
  it('a hold without a reason → HOLD_WITHOUT_REASON', () => {
    const h = hold();
    delete h.reason;
    expect(codes(holdOf(h))).toEqual(['HOLD_WITHOUT_REASON']);
    expect(emittedAccepts(h)).toBe(false);
  });

  it('an empty reason → HOLD_WITHOUT_REASON', () => {
    expect(codes(holdOf({ ...hold(), reason: '' }))).toEqual(['HOLD_WITHOUT_REASON']);
  });

  it('a blank reason → HOLD_WITHOUT_REASON', () => {
    expect(codes(holdOf({ ...hold(), reason: '  \n ' }))).toEqual(['HOLD_WITHOUT_REASON']);
  });

  it('a hold on a reply, not a thread', () => {
    const h = { ...hold(), thread: 'FP-ACK-7' };
    expect(holdOf(h).map((r) => `${r.code} ${r.path}`)).toEqual(['SCHEMA_VIOLATION /thread']);
    expect(emittedAccepts(h)).toBe(false);
  });

  it('a release needs no reason', () => {
    const h: Doc = { ...hold(), action: 'release' };
    delete h.reason;
    const held = parseHold(hold());
    if (!held.ok) throw new Error('fixture hold');
    expect(holdOf(h, [held.value])).toEqual([]);
  });
});
