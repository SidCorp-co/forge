// ISS-773: a client loads one action's input and guide at a time, so every action of every door
// has its own entry: its guide sliced from its door's description, its input narrowed to the
// arguments its entry names. An action with no entry, or an entry naming an argument the door does
// not take, is refused when the registry is built.
//
// @direct-test-of packages/core/src/mcp/action-catalog.ts
// @direct-test-of packages/core/src/support/tool.ts
// @direct-test-of packages/core/src/product-door/design-describe.ts

import { PERMISSIONS } from '@forge/contracts/permissions';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@forge/contracts/workflow-templates';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import { EXAMPLE_PLACEHOLDERS, type McpContext, type McpTool } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { projectDocumentSchema } from '../project-config/schema.js';
import { checkWorkflow, parseWorkflow } from '../workflows/rules.js';
import { actionCatalog, findActions } from './action-catalog.js';
import { forgeMcpInstructions, mcpTools, toolListing } from './server.js';

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

  // the ISS-538 judge (2026-11-02): issues.create's guide sent a caller to project_feedback.create,
  // which answers MCP_ACTION_UNKNOWN; a guide naming an action a client cannot call is a dead end
  it('names, in every door guide and in the server instructions, only actions it serves', () => {
    // a permission reads the same way (`releases.approve`), and a guide names it as one
    const permissionNames = new Set<string>(PERMISSIONS);
    const doors = new Set([...catalog.keys()].map((id) => id.split('.')[0] as string));
    const named = new RegExp(`\\b(${[...doors].join('|')})\\.([a-z][a-z_]*)\\b`, 'g');
    const texts = [
      ...tools.map((t) => [t.name, t.description] as const),
      ['instructions', forgeMcpInstructions()] as const,
    ];
    const dead = texts.flatMap(([where, text]) =>
      [...text.matchAll(named)]
        .map((m) => `${m[1]}.${m[2]}`)
        .filter((id) => !catalog.has(id) && !permissionNames.has(id))
        .map((id) => `${where}: ${id}`),
    );
    expect(dead).toEqual([]);
  });

  // a client sees five tools and calls a door's action by forge_call, so a guide naming a door by
  // its internal tool name (project_feedback's `find it with forge_requirements`) is a dead end too
  // REQ-78 BC-10: what a client loads on connecting is a map, and the rest loads on demand
  it('keeps the connect instructions a map of 2.5 KB or less that names how to load more', () => {
    const text = forgeMcpInstructions();
    expect(text.length).toBeLessThanOrEqual(2560);
    for (const step of ['forge_find', 'forge_describe', 'forge_call', 'guide:agent-setup']) {
      expect(text).toContain(step);
    }
  });

  it('names no door by its internal tool name in a door guide, only the tools a client lists', () => {
    const listedTools = new Set(['forge_find', 'forge_describe', 'forge_call']);
    const dead = tools.flatMap((t) =>
      [...t.description.matchAll(/\bforge_[a-z_]+\b/g)]
        .map((m) => m[0])
        .filter((name) => !listedTools.has(name))
        .map((name) => `${t.name}: ${name}`),
    );
    expect(dead).toEqual([]);
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
    // ISS-1195: a door's shared description matched every action of the door alike, so this
    // query answered 16 `ecosystem.*` lines; such an action now scores on its own id
    const shared = findActions(catalog, 'read a Forge guide by its slug', 20).filter((e) =>
      /^(ecosystem|channel)\./.test(e.id),
    );
    expect(shared.length).toBeLessThanOrEqual(3);
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

// ISS-1033: support.record's entry read `record {thread, kind, title, summary, asker?}`, so
// forge_describe answered no project and the room's session filed a followed project's need on its
// home (FB-530). A door that judges each action under its own request answers that request, and an
// entry naming other arguments is refused at registry build.
describe('a door judging each action under its own request', () => {
  const support = tools.find((t) => t.name === 'forge_support') as McpTool;
  const TODAY = 'record {thread, kind, title, summary, asker?}:';

  it('answers support.record as its request takes it: project and whereSeen, under its own guide', () => {
    const record = catalog.get('support.record');
    expect(record?.guideOf).toBe('action');
    expect(
      record?.guide.startsWith(
        'record {thread, kind, title, summary, whereSeen?, asker?, project?}:',
      ),
    ).toBe(true);
    expect(Object.keys(record?.input.properties as object)).toEqual(
      expect.arrayContaining([
        'thread',
        'kind',
        'title',
        'summary',
        'whereSeen',
        'asker',
        'project',
      ]),
    );
    expect(record?.input.required).toEqual(['thread', 'kind', 'title', 'summary']);
    // the door's own argument, which no request takes, every action takes
    expect(Object.keys(record?.input.properties as object)).toContain('rid');
    expect(Object.keys(catalog.get('support.search')?.input.properties as object)).toEqual(
      expect.arrayContaining(['query', 'project', 'rid']),
    );
  });

  it('refuses today’s record entry by name at registry build, naming the arguments it hides', () => {
    const entry = support.description.indexOf(
      'record {thread, kind, title, summary, whereSeen?, asker?, project?}:',
    );
    expect(entry).toBeGreaterThan(0);
    const description = support.description.replace(
      'record {thread, kind, title, summary, whereSeen?, asker?, project?}:',
      TODAY,
    );
    expect(() => actionCatalog([{ ...support, description }])).toThrow(
      "mcp registry: forge_support's entry for record leaves out `whereSeen`, `project`, which its request takes",
    );
  });

  const requested = (description: string) =>
    ({
      ...fake(
        description,
        { a: { type: 'string' }, b: { type: 'string' }, rid: { type: 'string' } },
        ['one'],
      ),
      actionRequests: {
        one: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    }) as McpTool;

  it('answers the request, the door’s own argument beside it, where the entry names exactly its arguments', () => {
    const one = actionCatalog([requested('one { a, b? }: does one.')]).get('fake.one');
    expect(one?.input).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' }, rid: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('refuses an entry that hides an argument its request takes, or names one it does not', () => {
    expect(() => actionCatalog([requested('one { a }: does one.')])).toThrow(
      "forge_fake's entry for one leaves out `b`, which its request takes",
    );
    expect(() => actionCatalog([requested('one { a, b, rid }: does one.')])).toThrow(
      "forge_fake's entry for one names `rid`, which its request does not take",
    );
  });
});

// REQ-78 BC-3 (ISS-1185): a client loads one action by find, describe and call, so describe has to
// be enough to call it. FB-595..598 read on forge-dev: requirements.create's `criteria` said
// "revise: the whole list", every guide but its door's last ended in a dangling "-", and no create
// action carried an example a client could send.
/** An example as its caller sends it: each placeholder filled with the value it stands for. */
const asCalled = (example: unknown): unknown => {
  const held: Record<string, string> = {
    '<project uuid>': '00000000-0000-4000-8000-0000000011a5',
    '<project slug>': 'shop',
    '<workflow uuid>': '00000000-0000-4000-8000-0000000011a6',
    '<plugin sha>': '73225dedb41b5da26b4ce73518086e26e81f91b8',
  };
  expect(Object.keys(held).sort()).toEqual(Object.keys(EXAMPLE_PLACEHOLDERS).sort());
  return JSON.parse(JSON.stringify(example), (_k, v) =>
    typeof v === 'string' && v in held ? held[v] : v,
  );
};

describe('describe is enough to call each action as written', () => {
  // the product layer's doors; channel and ecosystem are kept for forge-plugin clients under the
  // amnesty `mcp-tools-with-rest-twins` (mcp/registry.ts), and carry no example yet
  const PRODUCT = /^(?:requirements|project_feedback|feedback|design|issues|projects|config)\./;
  const creates = [...catalog.values()].filter(
    (e) => PRODUCT.test(e.id) && /(?:^|_)create$|^submit$/.test(e.action),
  );

  it('ends no guide in a bullet', () => {
    const dangling = [...catalog.values()]
      .filter((e) => /(?:^|\n)\s*[-*]\s*$/.test(e.guide))
      .map((e) => e.id);
    expect(dangling).toEqual([]);
  });

  it("gives each create action its own field texts, none of them a revise's", () => {
    expect(creates.length).toBeGreaterThan(3);
    const said = creates.flatMap((e) =>
      Object.entries((e.input.properties ?? {}) as Record<string, { description?: string }>)
        .filter(([, p]) => /revise/i.test(p.description ?? ''))
        .map(([name, p]) => `${e.id}.${name}: ${p.description}`),
    );
    expect(said).toEqual([]);
  });

  it('carries, for each create action, one example its own input accepts as written', () => {
    const strict = new Ajv2020({ strict: false, validateFormats: false });
    const missing = creates.filter((e) => e.example === undefined).map((e) => e.id);
    expect(missing).toEqual([]);
    for (const e of creates) {
      const valid = strict.validate(e.input, asCalled(e.example));
      expect(valid, `${e.id}: ${JSON.stringify(strict.errors)}`).toBe(true);
    }
  });
});

describe('the writes a client set a project up by over MCP (FB-595..598)', () => {
  it('describes design create and revise each alone, naming its document schema where it is served', () => {
    const create = catalog.get('design.design_create');
    const revise = catalog.get('design.design_revise');
    expect(create?.guide).not.toContain('design_revise');
    expect(revise?.guide).not.toContain('design_create');
    for (const [e, file] of [
      [create, 'workflow-v2.json'],
      [revise, 'workflow-v2.json'],
      [catalog.get('config.write'), 'project-v1.json'],
    ] as const) {
      expect(e?.documentSchema, e?.id).toMatch(new RegExp(`/api/schemas/${file}$`));
      expect(e?.documentSchema, e?.id).not.toContain('forge.sidcorp.co');
    }
    expect(revise?.example).toBeDefined();
  });

  it("design_create's example is a design the built-in templates accept, with no stamps or writtenBy", () => {
    const body = (asCalled(catalog.get('design.design_create')?.example) as { body: unknown })
      .body as { document: Record<string, unknown> };
    for (const owned of ['id', 'createdAt', 'updatedAt', 'writtenBy']) {
      expect(body.document, owned).not.toHaveProperty(owned);
    }
    const parsed = parseWorkflow(body.document, '00000000-0000-4000-8000-0000000011a5');
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.writtenBy).toEqual({});
    expect(
      checkWorkflow(parsed.value, {
        templates: [...BUILTIN_WORKFLOW_TEMPLATES],
        designs: new Map(),
      }),
    ).toEqual([]);
  });

  it("config.write's example is a project document its schema accepts", () => {
    const { document } = asCalled(catalog.get('config.write')?.example) as { document: unknown };
    const parsed = projectDocumentSchema.safeParse(document);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('takes project_feedback.submit’s one target as one field, never seven', () => {
    const submit = catalog.get('project_feedback.submit');
    const props = Object.keys(submit?.input.properties as object);
    expect(props).toContain('target');
    for (const loose of ['issue', 'release', 'workflow', 'endpoint', 'mockup', 'screen']) {
      expect(props, loose).not.toContain(loose);
    }
    expect(submit?.input.required).toEqual(expect.arrayContaining(['kind', 'title', 'target']));
    expect(submit?.guide).toMatch(/fits none of them/);
  });

  it('reads and writes a project’s gates and the profile table, each its own action', () => {
    expect(catalog.get('config.gates_get')?.input.required).toEqual(['projectId']);
    expect(catalog.get('config.gates_write')?.input.required).toEqual(
      expect.arrayContaining(['projectId', 'baseRevision', 'profile', 'reason']),
    );
    expect(catalog.get('config.gate_profiles')).toBeDefined();
    expect(catalog.get('design.template_list')).toBeDefined();
    expect(catalog.get('projects.create')?.guide).toMatch(/config\.write/);
  });
});
