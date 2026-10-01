import { describe, expect, it } from 'vitest';
import {
  channelWorld,
  doc,
  documentFiles,
  FORGE,
  holdFiles,
  holdWorld,
  OWNER,
  PLUGIN,
} from './channel.fixture.js';
import { proseOf } from './channel-content.js';
import {
  type ChannelWorld,
  documentRefusals,
  holdRefusals,
  parseChannelDocument,
  parseHold,
} from './channel-rules.js';
import type { ChannelDocument, ThreadHold } from './channel-schema.js';
import { type Doc, EPS, emittedAccepts } from './ecosystem.fixture.js';

const codes = (refusals: { code: string }[]) => refusals.map((r) => r.code);

function rulesOf(d: Doc, world: Partial<ChannelWorld> = {}) {
  const parsed = parseChannelDocument(d);
  if (!parsed.ok) throw new Error(`the plant broke the shape: ${JSON.stringify(parsed.refusals)}`);
  return documentRefusals(parsed.value, channelWorld(world));
}

function holdOf(h: Doc, holds: ThreadHold[] = []) {
  const parsed = parseHold(h);
  if (!parsed.ok) return parsed.refusals;
  return holdRefusals(parsed.value, holdWorld({ holds }));
}

describe('every design example passes the schema, the emitted schema and the rules', () => {
  it('reads seven documents and one hold', () => {
    expect(documentFiles()).toHaveLength(6);
    expect(holdFiles()).toHaveLength(1);
  });

  it.each(documentFiles())('%s', (file) => {
    const d = doc(file);
    expect(emittedAccepts(d)).toBe(true);
    expect(parseChannelDocument(d)).toMatchObject({ ok: true });
    expect(rulesOf(d)).toEqual([]);
  });

  it.each(holdFiles())('%s', (file) => {
    const h = doc(file);
    expect(emittedAccepts(h)).toBe(true);
    expect(holdOf(h)).toEqual([]);
  });
});

const cn = () => doc('FP-CN-12.document.json');
const ack = () => doc('FP-ACK-7.document.json');
const dec = () => doc('FP-DEC-9.document.json');
const hold = () => doc('FP-CR-3.hold.json');

const owner = { kind: 'person', id: OWNER, via: 'assistant' };
const master = { kind: 'agent', id: 'master-forge-dev', via: 'master' };
const decOnCr = (author: Doc) => ({
  ...dec(),
  inReplyTo: 'FP-CR-3',
  number: 'FP-DEC-10',
  body: { disposition: 'accepted', reason: 'Useful to both sides.', plannedOn: '2026-10-09' },
  authoredBy: author,
});

const rulePlants: [string, string, string, () => Doc, Partial<ChannelWorld>?][] = [
  [
    'a code block in the migration',
    'CONTENT_CODE',
    '/body/migration',
    () => {
      const d = cn();
      d.body.migration = 'Change the call:\n```ts\nopen({ policyVersion: sha })\n```';
      return d;
    },
  ],
  [
    'an internal path in a change',
    'CONTENT_INTERNAL_REF',
    '/body/changes/0/text',
    () => {
      const d = cn();
      d.body.changes[0].text = 'Validated now in packages/core before the insert.';
      return d;
    },
  ],
  [
    'a source file named in prose',
    'CONTENT_INTERNAL_REF',
    '/body/summary',
    () => {
      const d = cn();
      d.body.summary = 'The check now lives in src/runs/open-session.ts and runs first.';
      return d;
    },
  ],
  [
    'an internal issue key',
    'CONTENT_INTERNAL_REF',
    '/body/summary',
    () => {
      const d = cn();
      d.body.summary = 'Needed for ISS-1303, which stamps the policy version.';
      return d;
    },
  ],
  [
    'an internal module name',
    'CONTENT_INTERNAL_REF',
    '/body/summary',
    () => {
      const d = cn();
      d.body.summary = 'The runner now sends it from its dispatch gate.';
      return d;
    },
  ],
  [
    'an internal module in the subject',
    'CONTENT_INTERNAL_REF',
    '/subject',
    () => ({ ...ack(), subject: 'FP-CN-12: forge-cli will send policyVersion soon' }),
  ],
  [
    'a token pasted in prose',
    'CONTENT_SECRET',
    '/body/migration',
    () => {
      const d = cn();
      d.body.migration = 'Test with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x';
      return d;
    },
  ],
  [
    'a GitHub token',
    'CONTENT_SECRET',
    '/body/note',
    () => {
      const d = ack();
      d.body.note = `Try it with ghp_${'a'.repeat(36)} if the box asks.`;
      return d;
    },
  ],
  [
    'a Forge personal access token the scrubber knows',
    'CONTENT_SECRET',
    '/body/note',
    () => {
      const d = ack();
      d.body.note = `The box sends forge_pat_prd_${'a1'.repeat(16)} on every call.`;
      return d;
    },
  ],
  [
    'telling the consumer how to code',
    'CONTENT_PRESCRIBES_IMPLEMENTATION',
    '/body/migration',
    () => {
      const d = cn();
      d.body.migration = 'You must change your code in the transport layer to add the field.';
      return d;
    },
  ],
  [
    'a classification lowered below measured',
    'CLASSIFICATION_BELOW_MEASURED',
    '/body/classification',
    () => {
      const d = cn();
      d.body.classification = 'non-breaking';
      return d;
    },
  ],
  [
    'a measured breaking change left out',
    'MEASURED_CHANGE_OMITTED',
    '/body/changes',
    () => {
      const d = cn();
      d.body.changes = d.body.changes.slice(1);
      return d;
    },
  ],
  [
    'a breaking change effective before replies are due',
    'EFFECTIVE_BEFORE_DUE',
    '/body/effectiveOn',
    () => {
      const d = cn();
      d.body.effectiveOn = '2026-10-03';
      return d;
    },
  ],
  [
    'a sunset sooner than the promised notice',
    'SUNSET_BEFORE_NOTICE_PERIOD',
    '/body/deprecation/sunsetOn',
    () => {
      const d = cn();
      d.body.deprecation = {
        elements: ['GET /api/issues/{id}'],
        deprecatedOn: '2026-10-01',
        sunsetOn: '2026-10-10',
      };
      return d;
    },
  ],
  [
    "a notice about another project's contract",
    'CONTRACT_NOT_SENDERS',
    '/body/contract',
    () => {
      const d = cn();
      d.body.contract = 'forge-plugin/driver-skill';
      return d;
    },
  ],
  [
    'a version core never recorded',
    'VERSION_UNKNOWN',
    '/body/contractVersion',
    () => {
      const d = cn();
      d.body.contractVersion = '2027-01-01';
      return d;
    },
  ],
  [
    'the author drops a consumer who is owed the notice',
    'RECIPIENTS_NOT_DERIVED',
    '/to',
    () => ({ ...cn(), to: [FORGE] }),
  ],
  [
    'published without approval',
    'PUBLISHED_WITHOUT_GATE',
    '/gate',
    () => ({ ...cn(), gate: { mode: 'approve' } }),
  ],
  [
    'returned without a note',
    'GATE_RETURN_WITHOUT_NOTE',
    '/gate/note',
    () => ({
      ...cn(),
      state: 'returned',
      gate: {
        mode: 'approve',
        decision: 'returned',
        decidedBy: OWNER,
        decidedAt: '2026-10-01T10:00:00Z',
      },
    }),
  ],
  [
    "a gate mode other than the ecosystem's for this type",
    'GATE_MODE_MISMATCH',
    '/gate/mode',
    () => ({
      ...cn(),
      gate: {
        mode: 'approve',
        decision: 'approved',
        decidedBy: OWNER,
        decidedAt: '2026-10-01T10:00:00Z',
      },
    }),
  ],
  [
    'a master answers a thread a person has held',
    'THREAD_HELD',
    '/inReplyTo',
    () => decOnCr(master),
  ],
  [
    'an acknowledgement to an RFI',
    'REPLY_TYPE_NOT_ALLOWED',
    '/inReplyTo',
    () => ({ ...ack(), inReplyTo: 'FP-RFI-4' }),
  ],
  [
    'an answer from a project the notice was not sent to',
    'REPLY_FROM_NON_RECIPIENT',
    '/from',
    () => ({ ...ack(), from: FORGE, to: [PLUGIN] }),
  ],
  [
    'an RFI answered with accepted',
    'DISPOSITION_NOT_FOR_TYPE',
    '/body/disposition',
    () => ({
      ...dec(),
      body: { disposition: 'accepted', reason: 'ok', plannedOn: '2026-10-05' },
    }),
  ],
  [
    'a change request answered with answered',
    'DISPOSITION_NOT_FOR_TYPE',
    '/body/disposition',
    () => ({
      ...decOnCr(owner),
      body: { disposition: 'answered', reason: 'ok', answer: 'Yes, it is.' },
    }),
  ],
  [
    'a decision with a null parent',
    'REPLY_WITHOUT_PARENT',
    '/inReplyTo',
    () => ({ ...dec(), inReplyTo: null }),
  ],
  [
    'a reply to a number the channel never published',
    'REF_UNRESOLVED',
    '/inReplyTo',
    () => ({ ...ack(), inReplyTo: 'FP-CN-99' }),
  ],
  [
    'a reply to a withdrawn notice',
    'REPLY_TO_ENDED',
    '/inReplyTo',
    () => ack(),
    {
      documents: new Map([
        ['FP-CN-12', { ...cn(), state: 'withdrawn', withdrawnReason: 'wrong' } as ChannelDocument],
      ]),
    },
  ],
  [
    'adapting after the notice sunsets',
    'ADAPT_AFTER_SUNSET',
    '/body/adaptBy',
    () => ack(),
    {
      documents: new Map([
        [
          'FP-CN-12',
          {
            ...cn(),
            body: {
              ...cn().body,
              deprecation: {
                elements: ['GET /api/issues/{id}'],
                deprecatedOn: '2026-09-01',
                sunsetOn: '2026-10-05',
              },
            },
          } as ChannelDocument,
        ],
      ]),
    },
  ],
  [
    'a number from another channel',
    'NUMBER_NOT_IN_CHANNEL',
    '/number',
    () => ({ ...cn(), number: 'EPS-CN-12' }),
  ],
  [
    'a number of another type',
    'NUMBER_TYPE_MISMATCH',
    '/number',
    () => ({ ...cn(), number: 'FP-CR-12' }),
  ],
  [
    'a sender that is not an active member',
    'MEMBERSHIP_NOT_ACTIVE',
    '/from',
    () => cn(),
    { active: new Set([PLUGIN]) },
  ],
  [
    'a recipient that is not a counterparty',
    'RECIPIENT_NOT_COUNTERPARTY',
    '/to/0',
    () => ({ ...doc('FP-RFI-4.document.json'), from: FORGE, to: [PLUGIN] }),
    { edges: [] },
  ],
  [
    'a reply owed before tomorrow',
    'DUE_BY_TOO_SOON',
    '/dueBy',
    () => ({ ...doc('FP-RFI-4.document.json'), state: 'draft', number: null, dueBy: '2026-10-01' }),
  ],
];

describe('a document that breaks a rule is refused naming that rule', () => {
  it.each(rulePlants)('%s → %s at %s', (_name, code, path, plant, world) => {
    const found = rulesOf(plant(), world);
    expect(found.map((r) => `${r.code} ${r.path}`)).toContain(`${code} ${path}`);
  });

  it('a person still answers a thread a person has held', () => {
    expect(rulesOf(decOnCr(owner))).toEqual([]);
  });

  it('an agent answers the thread again once it is released', () => {
    const held = doc('FP-CR-3.hold.json') as ThreadHold;
    const released = { ...held, action: 'release', at: '2026-10-01T13:00:00Z' } as ThreadHold;
    expect(rulesOf(decOnCr(master), { holds: [held, released] })).toEqual([]);
  });

  it('a hold on another thread does not stop an agent here', () => {
    const held = { ...(doc('FP-CR-3.hold.json') as ThreadHold), thread: 'FP-RFI-4' };
    expect(rulesOf(decOnCr(master), { holds: [held] })).toEqual([]);
  });

  it('refuses a sender with no interface rather than send unscanned prose', () => {
    const found = rulesOf(doc('FP-RFI-4.document.json'), { interfaces: new Map() });
    expect(found.map((r) => `${r.code} ${r.path}`)).toContain('CONTENT_INTERNAL_REF /from');
  });

  it('names its own channel numbers without calling them internal keys', () => {
    const d = ack();
    d.body.note = 'Same as FP-RFI-4 and FP-DEC-9 said.';
    expect(rulesOf(d)).toEqual([]);
  });

  it('reads an example payload and an element name as contract words, not prose', () => {
    const scanned = proseOf(cn().body).map((p) => p.path);
    expect(scanned).toContain('/body/migration');
    expect(scanned.some((p) => p.includes('payload') || p.endsWith('/element'))).toBe(false);
  });
});

describe('a hold that breaks a rule is refused naming that rule', () => {
  const plants: [string, string, string, (h: Doc) => void][] = [
    [
      'an agent holds a thread',
      'HOLD_NOT_AUTHORISED',
      '/by',
      (h) => {
        h.by = { kind: 'agent', id: OWNER, via: 'master' };
      },
    ],
    [
      'a person with no role on the side',
      'HOLD_NOT_AUTHORISED',
      '/by',
      (h) => {
        h.by.id = '00000000-0000-4000-8000-00000000dead';
      },
    ],
    [
      'a side that is not a party',
      'HOLD_NOT_AUTHORISED',
      '/side',
      (h) => {
        h.side = '9a5d4e7c-bf6b-4c2e-9354-6e7f8091a2b4';
      },
    ],
    [
      'a thread that does not exist',
      'REF_UNRESOLVED',
      '/thread',
      (h) => {
        h.thread = 'FP-CR-99';
      },
    ],
  ];
  it.each(plants)('%s → %s at %s', (_name, code, path, mut) => {
    const h = hold();
    mut(h);
    expect(holdOf(h).map((r) => `${r.code} ${r.path}`)).toContain(`${code} ${path}`);
  });

  it('refuses holding a held thread and releasing a free one', () => {
    const held = parseHold(hold());
    if (!held.ok) throw new Error('fixture hold');
    expect(codes(holdOf(hold(), [held.value]))).toEqual(['THREAD_ALREADY_HELD']);
    expect(codes(holdOf({ ...hold(), action: 'release' }))).toEqual(['THREAD_NOT_HELD']);
  });
});

describe('a notice is owed to the consumers its version breaks', () => {
  it('owes no notice to a consumer in another ecosystem', () => {
    const world = channelWorld();
    const edges = world.edges.map((e) => ({ ...e, ecosystemId: EPS }));
    expect(codes(rulesOf(cn(), { edges }))).toContain('RECIPIENTS_NOT_DERIVED');
  });
});
