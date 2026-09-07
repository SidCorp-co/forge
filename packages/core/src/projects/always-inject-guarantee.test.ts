/**
 * ISS-936 — `alwaysInject` renders a project's fact under "Hard rules … Follow
 * them exactly" and nothing reads the rule back. These assertions hold the
 * sentence that says so on every surface that offers the flag, and hold the one
 * surface that must NOT carry it.
 *
 * The tests that matter are the two source reads: `project-facts-tab.tsx` is in
 * another package and cannot import the constant, and `resolve.ts` is asserted
 * for an ABSENCE, which no interpolation can guarantee.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FORGE_GUIDES } from '../guides/registry.js';
import { ALWAYS_INJECT_ENFORCEMENT_NOTE, ALWAYS_INJECT_GUARANTEE_NOTE } from './project-facts.js';

// cm:guard the MCP tool module reaches `config/env.js` transitively and throws at IMPORT without DATABASE_URL/JWT_SECRET. Only `description` is under test, so env and the client are stubbed rather than the assertion weakened to a source grep — a grep for the identifier proves it is referenced, never that it lands in the text an agent reads.
vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { forgeConfigTool } = await import('../mcp/tools/forge-config.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '../../../..');

function read(relative: string): string {
  return readFileSync(resolvePath(REPO, relative), 'utf8');
}

/** Comment lines only — a `cm:` annotation naming the constant is not a use of it. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('{/*');
    })
    .join('\n');
}

// cm:guard the tool factory is context-scoped and a real `ctx` needs a principal and a DB. Only `description` is under test, so a cast of the minimum shape is correct here.
const fakeCtx = { principal: {}, deprecations: new Set<string>() } as never;

describe('ALWAYS_INJECT_GUARANTEE_NOTE — the line the owner reads', () => {
  it('says the fact is guaranteed read and not guaranteed done', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('is READ');
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('never that it was DONE');
  });

  it('says nothing checks the rule was followed', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).toContain('nothing checks whether the agent followed it');
  });

  it('promises nothing about enforcement', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE).not.toMatch(
      /must always follow|will be followed|enforced|guaranteed to be followed/,
    );
  });

  // cm:guard the project's own UX contract asks body copy for ONE calm line, and this string is body copy in the settings tab. A second sentence is what the split into `ALWAYS_INJECT_ENFORCEMENT_NOTE` exists to prevent.
  it('is one sentence, short enough to read as body copy', () => {
    expect(ALWAYS_INJECT_GUARANTEE_NOTE.length).toBeLessThanOrEqual(200);
    expect(ALWAYS_INJECT_GUARANTEE_NOTE.match(/\.\s/g)).toBeNull();
  });

  // cm:guard both strings render into an MCP tool description, a terminal-read guide body and (the first one) a browser paragraph. Markdown would be swallowed by exactly one of the three.
  it('neither note carries markdown', () => {
    for (const note of [ALWAYS_INJECT_GUARANTEE_NOTE, ALWAYS_INJECT_ENFORCEMENT_NOTE]) {
      expect(note).not.toContain('`');
      expect(note).not.toContain('**');
    }
  });
});

describe('ALWAYS_INJECT_ENFORCEMENT_NOTE — the detail the screen has no room for', () => {
  it('names all three of the ways compliance is not verified', () => {
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain(
      'No gate refuses a step that ignored an always-inject rule',
    );
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('no step is asked whether it complied');
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('no surface counts how often one was obeyed');
  });

  it('says where the injection IS visible, and where observance is not', () => {
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('visible afterwards on the job');
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('recorded nowhere');
  });

  it('names the one obligation on this deployment that does have a readback', () => {
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('ux_contract_rules');
    expect(ALWAYS_INJECT_ENFORCEMENT_NOTE).toContain('ux_findings');
  });
});

describe('the surfaces that interpolate it', () => {
  it("`forge_config`'s tool description carries both", () => {
    const { description } = forgeConfigTool(fakeCtx);
    expect(description).toContain(ALWAYS_INJECT_GUARANTEE_NOTE);
    expect(description).toContain(ALWAYS_INJECT_ENFORCEMENT_NOTE);
  });

  it('the `project-settings-and-test-credentials` guide carries both', () => {
    const guide = FORGE_GUIDES.find((g) => g.slug === 'project-settings-and-test-credentials');
    expect(guide?.body).toContain(ALWAYS_INJECT_GUARANTEE_NOTE);
    expect(guide?.body).toContain(ALWAYS_INJECT_ENFORCEMENT_NOTE);
  });

  it('the settings tab, which reads it off its own GET rather than restating it', () => {
    const source = read('packages/core/src/projects/project-facts-routes.ts');
    expect(source).toContain('alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE');
  });
});

// cm:guard these read SOURCE because neither claim can be made any other way: the tab is in another package and cannot import this constant, and the prompt's claim is an ABSENCE.
describe('the two surfaces the constant cannot reach', () => {
  const TAB = 'packages/web-v2/src/features/project-settings/components/project-facts-tab.tsx';

  it(`${TAB} renders the served sentence`, () => {
    expect(read(TAB)).toContain('alwaysInjectGuarantee');
  });

  // cm:guard the promise spanned two JSX lines when it was there, so the whitespace is collapsed before matching — a line-by-line grep for it went green while the sentence was still on the screen.
  it(`${TAB} makes the owner no promise that the rule is followed`, () => {
    const copy = withoutComments(read(TAB)).replace(/\s+/g, ' ');
    expect(copy).not.toMatch(/the agent must|must always follow|rules? the agent (must|will)/);
  });

  it('the agent prompt keeps its instruction and does NOT carry the guarantee', () => {
    const source = read('packages/core/src/prompt/facts/resolve.ts');
    expect(source).toContain('Follow them exactly.');
    expect(withoutComments(source)).not.toContain('ALWAYS_INJECT_GUARANTEE_NOTE');
    expect(withoutComments(source)).not.toContain('ALWAYS_INJECT_ENFORCEMENT_NOTE');
  });
});
