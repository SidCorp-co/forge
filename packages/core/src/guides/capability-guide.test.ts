/**
 * ISS-1329 — the capability page routes to guides core serves and says nothing a surface that
 * describes itself should say. Each rule below is exercised against a planted fault, so a green
 * run is a rule that can go red.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_AREAS,
  CAPABILITY_GUIDE,
  CAPABILITY_GUIDE_SLUG,
  type CapabilityArea,
} from './capability-guide.js';
import { CORPUS_SCOPE } from './corpus-scope.js';
import { FORGE_GUIDES, getGuide } from './registry.js';

/** `<area>: routes to <slug>, which core does not serve` for each unresolved route. */
function routeFaults(areas: readonly CapabilityArea[], known: ReadonlySet<string>): string[] {
  return areas.flatMap((a) =>
    a.guides
      .filter((slug) => !known.has(slug))
      .map((slug) => `${a.area}: routes to ${slug}, which core does not serve`),
  );
}

const FLAG = /(^|\s)--[a-z][a-z-]*/;
const TOOL_NAME = /\bforge_[a-z_]+/;

/** Each match of a flag or an MCP tool name in `text`, named. */
function surfaceFaults(label: string, text: string): string[] {
  const faults: string[] = [];
  for (const [kind, re] of [
    ['a CLI flag', FLAG],
    ['an MCP tool name', TOOL_NAME],
  ] as const) {
    const m = re.exec(text);
    if (m) faults.push(`${label}: carries ${kind} (${JSON.stringify(m[0].trim())})`);
  }
  return faults;
}

const KNOWN = new Set(FORGE_GUIDES.map((g) => g.slug));

describe('the capability guide', () => {
  it('is served under its own slug, as an agent guide', () => {
    expect(getGuide(CAPABILITY_GUIDE_SLUG)).toBe(CAPABILITY_GUIDE);
    expect(CAPABILITY_GUIDE.audience).toBe('agent');
  });

  it('routes every area only to guides core serves', () => {
    expect(CAPABILITY_AREAS.length).toBeGreaterThan(5);
    expect(routeFaults(CAPABILITY_AREAS, KNOWN)).toEqual([]);
  });

  it('names the guide that covers each area in its body', () => {
    for (const a of CAPABILITY_AREAS) {
      expect(a.guides.length, a.area).toBeGreaterThan(0);
      for (const slug of a.guides)
        expect(CAPABILITY_GUIDE.body, `${a.area}/${slug}`).toContain(`/api/guides/${slug}.md`);
    }
  });

  it('leaves no guide core serves unreachable from the map, the map itself excepted', () => {
    const routed = new Set(CAPABILITY_AREAS.flatMap((a) => a.guides));
    const orphans = FORGE_GUIDES.map((g) => g.slug).filter(
      (slug) => slug !== CAPABILITY_GUIDE_SLUG && !routed.has(slug),
    );
    expect(orphans).toEqual([]);
  });

  it('carries no flag and no tool name, here or in the corpus text', () => {
    expect(surfaceFaults('capability guide', CAPABILITY_GUIDE.body)).toEqual([]);
    expect(surfaceFaults('corpus scope', JSON.stringify(CORPUS_SCOPE))).toEqual([]);
  });

  it('points at the CLI for methods rather than restating one', () => {
    expect(CAPABILITY_GUIDE.body).toContain(CORPUS_SCOPE.reach);
    expect(CAPABILITY_GUIDE.body).toContain(CORPUS_SCOPE.authority);
  });
});

describe('those rules, against planted faults', () => {
  it('names a route to a slug core does not serve', () => {
    const planted: CapabilityArea[] = [{ area: 'Planted', covers: 'x', guides: ['no-such-guide'] }];
    expect(routeFaults(planted, KNOWN)).toEqual([
      'Planted: routes to no-such-guide, which core does not serve',
    ]);
  });

  it('names a CLI flag planted in a body', () => {
    expect(surfaceFaults('planted', 'run it with --force to skip')).toEqual([
      'planted: carries a CLI flag ("--force")',
    ]);
  });

  it('names an MCP tool name planted in a body', () => {
    expect(surfaceFaults('planted', 'call forge_issues to read it')).toEqual([
      'planted: carries an MCP tool name ("forge_issues")',
    ]);
  });
});
