import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    APP_BASE_URL: 'https://forge.test',
    UPLOADS_MAX_BYTES: 1,
    UPLOADS_INLINE_MAX_BYTES: 1,
    FEEDBACK_MAX_PER_JOB: 1,
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { mcpTools, toolListing } = await import('./server.js');
const { FORGE_GUIDES, getGuide } = await import('../guides/registry.js');
const { GUIDE_SLUGS } = await import('../guides/guide-ref.js');
const { FORGE_FACTS } = await import('../prompt/facts/registry.js');

const GUIDE_CITATION =
  /forge_guide get `?([a-z0-9]+(?:-[a-z0-9]+)*)`?|\bguide `([a-z0-9]+(?:-[a-z0-9]+)+)`/g;
const DESIGN_CITATION = /\b(?:workflows?|designs?) `?[a-z]+(?:-[a-z0-9]+)+`?/g;

const AMNESTY: ReadonlyMap<string, string> = new Map();

function referenceFaults(
  surface: string,
  text: string,
  amnesty: string | undefined = undefined,
): string[] {
  const faults: string[] = [];
  for (const m of text.matchAll(GUIDE_CITATION)) {
    const slug = m[1] ?? m[2] ?? '';
    if (!getGuide(slug)) {
      faults.push(
        `${surface}: cites guide \`${slug}\`, which no registered guide holds; cite one through guides/guide-ref.ts:guideRef`,
      );
    }
  }
  for (const m of text.matchAll(DESIGN_CITATION)) {
    const cited = m[0].replaceAll('`', '');
    if (cited === amnesty) continue;
    faults.push(
      `${surface}: cites \`${cited}\`, a design one project holds and another project's agent cannot read; cite a public guide through guides/guide-ref.ts:guideRef`,
    );
  }
  if (amnesty && !text.includes(amnesty)) {
    faults.push(
      `${surface}: holds an amnesty for \`${amnesty}\` it no longer cites; delete the amnesty entry`,
    );
  }
  return faults;
}

const fakeCtx = { principal: { userId: 'u1' }, deprecations: new Set<string>() } as never;

describe('what an agent-facing reference names', () => {
  it('is, in every MCP tool description and input schema, a registered guide and never a design id', () => {
    const faults = mcpTools(fakeCtx).flatMap((tool) =>
      referenceFaults(
        `tool ${tool.name}`,
        JSON.stringify(toolListing([tool])),
        AMNESTY.get(tool.name),
      ),
    );
    expect(faults).toEqual([]);
  });

  it('is, in every registered guide, a registered guide and never a design id', () => {
    const faults = FORGE_GUIDES.flatMap((g) =>
      referenceFaults(`guide ${g.slug}`, `${g.summary}\n${g.body}`),
    );
    expect(faults).toEqual([]);
  });

  it('is, in every prompt fact, a registered guide and never a design id', () => {
    const faults = FORGE_FACTS.flatMap((f) => referenceFaults(`fact ${f.id}`, f.render()));
    expect(faults).toEqual([]);
  });

  it('names a guide for every slug the citation builder accepts', () => {
    expect(GUIDE_SLUGS.filter((slug) => !getGuide(slug))).toEqual([]);
  });

  it('holds no amnesty for a tool that is not served', () => {
    const served = new Set(mcpTools(fakeCtx).map((t) => t.name));
    expect([...AMNESTY.keys()].filter((name) => !served.has(name))).toEqual([]);
  });
});

describe('that guard, against planted references', () => {
  it('names a citation of a guide nobody wrote', () => {
    expect(referenceFaults('planted', 'see forge_guide get planted-nowhere for more')).toEqual([
      'planted: cites guide `planted-nowhere`, which no registered guide holds; cite one through guides/guide-ref.ts:guideRef',
    ]);
  });

  it('names a citation of a design id', () => {
    expect(referenceFaults('planted', 'Suggestions (workflow suggestion-lifecycle): …')).toEqual([
      "planted: cites `workflow suggestion-lifecycle`, a design one project holds and another project's agent cannot read; cite a public guide through guides/guide-ref.ts:guideRef",
    ]);
  });

  it('names an amnesty whose citation is gone', () => {
    expect(referenceFaults('planted', 'no design named', 'design agent-run-standing')).toEqual([
      'planted: holds an amnesty for `design agent-run-standing` it no longer cites; delete the amnesty entry',
    ]);
  });

  it('passes a registered guide cited through the builder', () => {
    expect(referenceFaults('planted', 'see forge_guide get suggestions')).toEqual([]);
  });
});
