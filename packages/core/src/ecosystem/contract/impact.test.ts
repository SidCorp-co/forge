import { describe, expect, it } from 'vitest';
import { channelWorld, contractFacts, doc, FORGE, PLUGIN } from '../channel.fixture.js';
import { type ChannelWorld, documentRefusals, parseChannelDocument } from '../channel-rules.js';
import { type Doc, example } from '../ecosystem.fixture.js';
import { type ImpactChange, type ImpactLink, linkImpact, recipientsOf } from './impact.js';

const raw = example('forge-plugin.link.json') as {
  id: string;
  consumer: { project: string; module: string };
  pinnedVersion: string;
  callSites: ImpactLink['callSites'];
  fieldsUsed: string[];
  outsideContract: string[];
};
const link: ImpactLink = {
  id: raw.id,
  consumer: raw.consumer.project,
  module: raw.consumer.module,
  pinnedVersion: raw.pinnedVersion,
  callSites: raw.callSites,
  fieldsUsed: raw.fieldsUsed,
  outsideContract: raw.outsideContract,
};

const removed = (element: string, field?: string): ImpactChange => ({
  element,
  level: 'breaking',
  kind: 'removed',
  text: field ? `removed the property \`${field}\` from the response` : `${element} was removed`,
  check: field ? 'response-property-removed' : 'api-path-removed-without-deprecation',
});

const measuredWith = (changes: ImpactChange[]) => ({ classification: 'breaking' as const, changes });
const impactOf = (changes: ImpactChange[]) =>
  linkImpact('dated', '2026-10-01', measuredWith(changes), link);

describe('a version is checked against the fields and surface each link uses', () => {
  it('passes a consumer that never reads the removed field', () => {
    const i = impactOf([removed('GET /api/issues/{id}', 'data/priority')]);
    expect(i).toMatchObject({ verdict: 'passes', reason: 'no-breaking-change-touches', breaks: [] });
    expect(recipientsOf([PLUGIN], [i])).toEqual([]);
  });

  it('breaks a consumer that reads the removed field, naming the field and the call site', () => {
    const i = impactOf([removed('GET /api/issues/{id}', 'data/status')]);
    expect(i.verdict).toBe('breaks');
    expect(i.breaks).toEqual([
      expect.objectContaining({
        element: 'GET /api/issues/{id}',
        fields: ['data.status'],
        callSites: [{ path: 'cli/src/commands/issue.ts', line: 42, operation: 'GET /api/issues/{id}' }],
        outsideContract: [],
      }),
    ]);
    expect(recipientsOf([PLUGIN], [i])).toEqual([
      { consumer: PLUGIN, reason: 'breaks', links: [link.id] },
    ]);
  });

  it('breaks a consumer whose outside-contract use is removed, whatever field it names', () => {
    const i = impactOf([removed('GET /api/issues/{id}/raw', 'body')]);
    expect(i.verdict).toBe('breaks');
    expect(i.breaks[0]).toMatchObject({ outsideContract: ['GET /api/issues/{id}/raw'], fields: [] });
  });

  it('breaks every caller of an operation that gains a required input, read or not', () => {
    const i = impactOf([
      {
        element: 'POST /api/issues/{id}/phase',
        level: 'breaking',
        kind: 'changed',
        text: 'added the new required request property `reason`',
        check: 'new-required-request-property',
      },
    ]);
    expect(i.breaks[0]?.callSites.map((s) => s.line)).toEqual([17]);
  });

  it('passes a link already built against the version and breaks one against an unmeasured version', () => {
    expect(linkImpact('dated', '2026-09-20', null, link)).toMatchObject({
      verdict: 'passes',
      reason: 'built-against',
    });
    expect(linkImpact('dated', '2026-10-01', null, link)).toMatchObject({
      verdict: 'breaks',
      reason: 'unmeasured',
    });
  });

  it('names a consumer with no link as unmapped rather than dropping it', () => {
    expect(recipientsOf([FORGE], [])).toEqual([{ consumer: FORGE, reason: 'unmapped', links: [] }]);
  });
});

const cn = () => doc('FP-CN-12.document.json');
const codes = (d: Doc, world: Partial<ChannelWorld>) => {
  const parsed = parseChannelDocument(d);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return documentRefusals(parsed.value, channelWorld(world)).map((r) => r.code);
};

function worldWith(change: ImpactChange, recordedOn = '2026-09-01'): Partial<ChannelWorld> {
  const facts = contractFacts();
  const measured = new Map(facts.measured);
  measured.set('forge/forge-api@2026-10-01', {
    classification: 'breaking',
    changes: [change],
  });
  const versions = new Map(facts.versions);
  const v = versions.get('forge/forge-api@2026-10-01');
  if (v) versions.set('forge/forge-api@2026-10-01', { ...v, recordedOn });
  return {
    contracts: { ...facts, measured, versions },
    links: [{ ...link, provider: FORGE, contractSlug: 'forge-api' }],
  };
}

describe('a change notice is addressed from the impact, not from the version pinned', () => {
  it('refuses a notice to a linked consumer the change does not touch', () => {
    const w = worldWith(removed('GET /api/issues/{id}', 'data/priority'));
    expect(codes(cn(), w)).toContain('RECIPIENTS_NOT_DERIVED');
  });

  it('accepts a notice to the linked consumer the change breaks', () => {
    const w = worldWith(removed('GET /api/issues/{id}', 'data/status'));
    expect(codes(cn(), w)).not.toContain('RECIPIENTS_NOT_DERIVED');
  });

  it('refuses a breaking deadline sooner than the version is reachable plus the notice promised', () => {
    const w = worldWith(removed('GET /api/issues/{id}', 'data/status'), '2026-10-01');
    expect(codes(cn(), w)).toContain('DEADLINE_BEFORE_REACHABLE');
    const ok = worldWith(removed('GET /api/issues/{id}', 'data/status'), '2026-09-09');
    expect(codes(cn(), ok)).not.toContain('DEADLINE_BEFORE_REACHABLE');
  });
});
