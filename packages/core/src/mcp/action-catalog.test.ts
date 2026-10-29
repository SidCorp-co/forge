// ISS-773: a client loads one action's input and guide at a time, so every action of every door
// has its own entry: its guide sliced from its door's description, its input narrowed to the
// arguments its entry names. An action with no entry, or an entry naming an argument the door does
// not take, is refused when the registry is built.
//
// @direct-test-of packages/core/src/mcp/action-catalog.ts

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext, McpTool } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { actionCatalog, findActions } from './action-catalog.js';
import { mcpTools, toolListing } from './server.js';

const principal = {
  kind: 'pat',
  agency: 'agent',
  agentUserId: null,
  userId: '00000000-0000-4000-8000-000000000773',
  tokenId: 'tok-773',
  scopes: ['read', 'write'],
  projectIds: null,
  permissions: ['*'],
  grantEpoch: PAT_GRANT_EPOCH,
  boundProjectId: null,
  deviceId: null,
  onBehalfOf: null,
} as unknown as PrincipalVars['principal'];

const tools = mcpTools({ principal, projectSlug: null } as unknown as McpContext);
const catalog = actionCatalog(tools);
const listed = new Map(toolListing(tools).map((t) => [t.name, t.inputSchema]));

const actionsOf = (t: McpTool) => {
  const a = (t.inputSchema.properties as Record<string, { enum?: string[]; const?: string }>)
    .action;
  return a?.enum ?? (a?.const ? [a.const] : []);
};

/** A tool with only a description and an input, for the parser's own cases. */
const fake = (description: string, properties: Record<string, unknown>, actions: string[]) =>
  ({
    name: 'forge_fake',
    description,
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: actions }, ...properties },
      required: ['action'],
      additionalProperties: false,
    },
    grant: 'projects:read',
    reach: 'project',
    handler: async () => null,
  }) as unknown as McpTool;

describe('the catalog of every served action', () => {
  it('holds one entry per action of every door, by <door>.<action>', () => {
    const expected = tools.flatMap((t) =>
      actionsOf(t).map((a) => `${t.name.replace(/^forge_/, '')}.${a}`),
    );
    expect([...catalog.keys()].sort()).toEqual(expected.sort());
    expect(expected.length).toBeGreaterThan(100);
  });

  it("gives each action its own guide, but where the door judges each action's own input", () => {
    for (const e of catalog.values()) {
      const tool = tools.find((t) => t.name === e.tool) as McpTool;
      expect(e.guideOf, e.id).toBe(tool.actionInputs ? 'door' : 'action');
      if (e.guideOf === 'action') expect(e.guide, e.id).toContain(e.action);
      expect(e.summary.length, e.id).toBeLessThanOrEqual(140);
    }
  });

  it('narrows each input to arguments its door takes, and passes strict JSON Schema', () => {
    const strict = new Ajv2020({ strict: true, strictRequired: true, validateFormats: false });
    for (const e of catalog.values()) {
      expect(e.input.type, e.id).toBe('object');
      expect(strict.validateSchema(e.input), `${e.id}: ${JSON.stringify(strict.errors)}`).toBe(
        true,
      );
      expect(() => strict.compile(e.input), e.id).not.toThrow();
      if (e.guideOf === 'action') {
        const door = listed.get(e.tool)?.properties as Record<string, unknown>;
        for (const name of Object.keys(e.input.properties as object))
          expect(Object.keys(door), `${e.id}.${name}`).toContain(name);
      }
    }
  });

  it("slices one action's guide alone: requirements.create holds none of revise's", () => {
    const create = catalog.get('requirements.create');
    expect(create?.guide.startsWith('create {')).toBe(true);
    expect(create?.guide).not.toContain('revise {');
    expect(create?.input.required).toEqual(['title']);
    expect(Object.keys(create?.input.properties as object)).toEqual(
      expect.arrayContaining(['title', 'criteria', 'spec', 'projectId']),
    );
  });

  it('finds an action by what it does', () => {
    expect(findActions(catalog, 'draft a requirement', 5).map((e) => e.id)).toContain(
      'requirements.create',
    );
    expect(findActions(catalog, 'answer question', 5).map((e) => e.id)).toContain(
      'questions.answer',
    );
    expect(findActions(catalog, '', 500)).toHaveLength(catalog.size);
    expect(findActions(catalog, 'qqqzzz', 5)).toEqual([]);
  });
});

describe('the entry forms a description names an action in', () => {
  const props = {
    a: { type: 'string' },
    b: { type: 'string' },
    c: { type: 'number' },
    target: { type: 'object' },
  };

  it('reads `name { args }:`, `action=name { args }:` and `name:` entries', () => {
    const c = actionCatalog([
      fake(
        'Intro. one { a, b? }: does one. action=two { c }: does two. three: does three.',
        props,
        ['one', 'two', 'three'],
      ),
    ]);
    expect(c.get('fake.one')).toMatchObject({ summary: 'does one.', input: { required: ['a'] } });
    expect(c.get('fake.one')?.guide).toBe('one { a, b? }: does one.');
    expect(c.get('fake.two')?.input.required).toEqual(['c']);
    expect(c.get('fake.three')?.input.properties).toEqual({});
  });

  it('shares the body of entries chained before one colon', () => {
    const c = actionCatalog([
      fake('verify { a } and reopen { b }: confirm or reopen. other { c }: else.', props, [
        'verify',
        'reopen',
        'other',
      ]),
    ]);
    expect(c.get('fake.reopen')?.guide).toBe('verify { a } and reopen { b }: confirm or reopen.');
    expect(c.get('fake.reopen')?.input.required).toEqual(['b']);
  });

  it('reads a listed signature, its note and the sentence that names it', () => {
    const c = actionCatalog([
      fake(
        'run moves a thing to its place. Actions: run { a }; walk { b } (slowly), sit { c }.',
        props,
        ['run', 'walk', 'sit'],
      ),
    ]);
    expect(c.get('fake.run')?.guide).toBe('run { a } run moves a thing to its place.');
    expect(c.get('fake.walk')?.guide).toBe('walk { b } (slowly)');
    expect(c.get('fake.sit')?.input.required).toEqual(['c']);
  });

  it('takes `a | b` and `exactly one of` as alternatives, a typed `name?: x | y` as one argument, and stops at an em dash', () => {
    const c = actionCatalog([
      fake(
        'pick { a | b, c?: low | high, exactly one of target | a — the target is what it is, or none }: picks.',
        props,
        ['pick'],
      ),
    ]);
    expect(c.get('fake.pick')?.input.required).toBeUndefined();
    expect(Object.keys(c.get('fake.pick')?.input.properties as object).sort()).toEqual([
      'a',
      'b',
      'c',
      'target',
    ]);
  });

  it('refuses an action its door describes no entry for, and an argument its door does not take', () => {
    expect(() => actionCatalog([fake('only { a }: one.', props, ['only', 'missing'])])).toThrow(
      /forge_fake's description holds no entry for its action missing/,
    );
    expect(() => actionCatalog([fake('only { zed }: one.', props, ['only'])])).toThrow(
      /forge_fake's entry for only names an argument `zed` its input does not take/,
    );
  });
});
