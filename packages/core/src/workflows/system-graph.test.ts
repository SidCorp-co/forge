import { readFileSync } from 'node:fs';
import { BUILTIN_WORKFLOW_TEMPLATES, findTemplate } from '@forge/contracts/workflow-templates';
import { describe, expect, it } from 'vitest';
import { type GraphDoc, integrationOf, systemGraphOf, withRemoved } from './system-graph.js';

// HOP's system-context design at rev 4 (17 steps, 24 lines), HOP's as dev held it on 2026-10-04 (31
// steps: 17 outside systems in four boundaries, five people) and forge's onboarding draft (22 steps).
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.design.json`, import.meta.url), 'utf8'),
  ) as GraphDoc & { lanes: NonNullable<GraphDoc['lanes']> };
const hop = fixture('hop-system-context');
const hopNow = fixture('hop-system-context-current');
const forge = fixture('forge-system-context');
const template = findTemplate(BUILTIN_WORKFLOW_TEMPLATES, { id: 'system-context', version: 1 });
if (!template) throw new Error('the built-ins lost system-context@1');
const graphOf = (doc: GraphDoc) => systemGraphOf(doc, template);

type Step = GraphDoc['steps'][number];
const step = (id: string, type: string, band: string | null, after: string[] = []): Step => ({
  id,
  title: id,
  does: id,
  status: 'designed',
  after,
  evidence: null,
  node: {
    type,
    label: id,
    ...(band ? { band } : {}),
    ...(type === 'SYSTEM' ? { owner: 'someone' } : {}),
  },
});

const design = (steps: Step[]): GraphDoc => ({
  steps,
  edges: steps.flatMap((s) =>
    s.after.map((a) => ({ from: a, to: s.id, label: `${a} to ${s.id}` })),
  ),
  lanes: [
    { id: 'people', label: 'People' },
    { id: 'ours', label: 'Our product' },
    { id: 'them', label: 'Partners' },
  ],
});

describe('design document -> system graph', () => {
  it("finds HOP's boundary as the system in scope, with its containers and the site inside", () => {
    const g = graphOf(hop);
    expect(g.focal?.boundary).toBe('hop');
    expect(g.focal?.title).toBe(hop.lanes.find((l) => l.id === 'hop')?.label);
    expect(g.focal?.parts.sort()).toEqual([
      'evaluate',
      'hop',
      'hop-db',
      'intake',
      'record-action',
      'retention',
      'sweep',
    ]);
    expect(g.nodes.filter((n) => n.kind === 'person').map((n) => n.id)).toEqual([
      'staff',
      'leads',
      'patient',
      'caregiver',
    ]);
    expect(
      g.nodes
        .filter((n) => n.kind === 'external')
        .map((n) => n.id)
        .sort(),
    ).toEqual(['forge', 'his', 'llm', 'records-policy', 'scheduling', 'zalo']);
  });

  it('keeps every relationship of the design with its own label and technology', () => {
    const g = graphOf(forge);
    expect(g.relationships).toHaveLength(27);
    expect(g.relationships.find((r) => r.id === 'member>runner')).toMatchObject({
      label: 'pairs the box, binds repos',
      technology: 'forge-runner CLI',
    });
    expect(g.relationships.every((r) => r.label.length > 0)).toBe(true);
  });

  it("labels a line the design gives no words with its kind's label, never a count", () => {
    const doc = design([step('a', 'PERSON', 'people'), step('core', 'SYSTEM', 'ours', ['a'])]);
    const g = graphOf({ ...doc, edges: [] });
    const [r] = g.relationships;
    expect(r).toMatchObject({ id: 'a>core', technology: null });
    expect(r?.label).toBe(r?.kind.label);
    expect(r?.label).not.toMatch(/\d|\blinks?\b/);
  });

  it('splits each lane into boundaries by side and counts the header facts once', () => {
    const g = graphOf(hopNow);
    expect(g.boundaries.map((b) => b.id)).toEqual([
      'people:people',
      'outside:hospital',
      'focal:hop',
      'outside:partners',
      'outside:channels',
      'outside:outside',
    ]);
    expect(g.facts.externals).toBe(17);
    expect(g.facts.namedBoundaries).toBe(4);
    expect(g.facts.people).toHaveLength(5);
    expect(g.facts.boundaries.reduce((n, b) => n + (b.count ?? 0), 0)).toBe(17);
  });

  it("states HOP rev 4's facts: four roles, six outside systems in three boundaries", () => {
    const f = graphOf(hop).facts;
    expect([f.people.length, f.externals, f.namedBoundaries]).toEqual([4, 6, 3]);
  });

  it("breaks HOP's seventeen outside systems down by boundary, in lane order, with how many are unconfirmed", () => {
    const f = graphOf(hopNow).facts;
    const lane = (id: string) => hopNow.lanes.find((l) => l.id === id)?.label;
    expect(f.boundaries).toEqual([
      { name: lane('hospital'), count: 9, unconfirmed: 6 },
      { name: lane('partners'), count: 3, unconfirmed: 3 },
      { name: lane('channels'), count: 2, unconfirmed: 0 },
      { name: lane('outside'), count: 3, unconfirmed: 0 },
    ]);
    const role = (id: string) => hopNow.steps.find((s) => s.id === id)?.node?.label;
    expect(f.people.map((x) => x.name)).toEqual(
      ['staff', 'leads', 'hospital-it', 'patient', 'caregiver'].map(role),
    );
  });

  it("reads the system's purpose only from what the design states, never from a step's `does`", () => {
    expect(graphOf(hop).focal?.purpose).toBe('');
    const stated = {
      ...hop,
      steps: hop.steps.map((s) =>
        s.id === 'hop'
          ? { ...s, node: { ...s.node, type: 'SYSTEM', purpose: 'The staff site' } }
          : s,
      ),
    };
    expect(graphOf(stated).focal?.purpose).toBe('The staff site');
  });

  it('takes the most connected system as the one in scope when the design draws no container', () => {
    const g = graphOf(
      design([
        step('a', 'PERSON', 'people'),
        step('core', 'SYSTEM', 'ours', ['a']),
        step('bank', 'SYSTEM', 'them', ['core']),
      ]),
    );
    expect(g.focal?.parts).toEqual(['core']);
    expect(g.nodes.find((n) => n.id === 'bank')?.kind).toBe('external');
  });

  it('has no system in scope for a design with no system at all', () => {
    const g = graphOf(
      design([step('a', 'PERSON', 'people'), step('b', 'PERSON', 'people', ['a'])]),
    );
    expect(g.focal).toBeNull();
  });

  it('counts an outside system in no boundary under "No boundary"', () => {
    const g = graphOf(
      design([
        step('a', 'PERSON', 'people'),
        step('core', 'SYSTEM', 'ours', ['a']),
        step('bank', 'SYSTEM', null, ['core']),
      ]),
    );
    expect(g.facts.boundaries).toEqual([{ name: 'No boundary', count: 1, unconfirmed: 0 }]);
    expect(g.facts.namedBoundaries).toBe(0);
  });
});

describe('a diff against an earlier revision', () => {
  it('draws the steps it removed, marked removed and left out of the facts', () => {
    const before = design([
      step('a', 'PERSON', 'people'),
      step('core', 'SYSTEM', 'ours', ['a']),
      step('bank', 'SYSTEM', 'them', ['core']),
      step('mail', 'SYSTEM', 'them', ['core', 'gone']),
    ]);
    const after = design([step('a', 'PERSON', 'people'), step('core', 'SYSTEM', 'ours', ['a'])]);
    const doc = withRemoved(after, before);
    const g = systemGraphOf(doc, template, new Set(['bank', 'mail']));
    expect(g.nodes.filter((n) => n.removed).map((n) => n.id)).toEqual(['bank', 'mail']);
    expect(doc.steps.find((s) => s.id === 'mail')?.after).toEqual(['core']);
    expect(g.relationships.map((r) => r.id)).toEqual(['a>core', 'core>bank', 'core>mail']);
    expect(g.facts.externals).toBe(0);
  });

  it('leaves a revision that removed nothing as it is', () => {
    const doc = design([step('a', 'PERSON', 'people')]);
    expect(withRemoved(doc, doc)).toBe(doc);
  });
});

describe("reading an outside system's integration state from its label", () => {
  it.each([
    ['EMR (chưa xác nhận tích hợp)', 'EMR', 'unconfirmed'], // i18n-allow: a label as HOP's design writes it
    ['SMS (đề xuất, chưa xác nhận)', 'SMS', 'unconfirmed'], // i18n-allow: a label as HOP's design writes it
    ['Partner / Referral systems (chưa xác nhận)', 'Partner / Referral systems', 'unconfirmed'], // i18n-allow: a label as HOP's design writes it
    ['Billing (proposed)', 'Billing', 'unconfirmed'],
    ['HIS / EMR', 'HIS / EMR', 'confirmed'],
    [
      'LLM, embedding, BA assistant (ở nước ngoài)', // i18n-allow: an aside that is not about confirmation
      'LLM, embedding, BA assistant (ở nước ngoài)', // i18n-allow: an aside that is not about confirmation
      'confirmed',
    ],
  ])('%s', (title, name, state) => {
    expect(integrationOf(title)).toMatchObject({ name, state });
  });

  it('marks an external as unconfirmed on the graph, with the aside it read', () => {
    const g = graphOf(hopNow);
    const open = g.nodes.filter((n) => n.integration === 'unconfirmed');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((n) => n.kind === 'external' && n.mark !== null && n.name !== n.title)).toBe(
      true,
    );
  });
});
