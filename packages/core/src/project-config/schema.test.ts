import { describe, expect, it } from 'vitest';
import { type ProjectConfigSchemaName, projectConfigJsonSchemas } from './json-schema.js';
import {
  allFixtures,
  clone,
  type Doc,
  expectAccepted,
  expectRefused,
  NAMES,
  nameOf,
  read,
} from './schema.fixture.js';
import { POLICY_STATE_STATUSES, PROJECT_DESCRIPTION_MAX } from './schema.js';

describe('fixtures (happy)', () => {
  const files = allFixtures();

  it('holds all twenty design documents', () => {
    expect(files).toHaveLength(20);
  });

  it.each(files)('%s is accepted by zod and by the emitted JSON Schema', (file) => {
    const doc = read(file);
    expectAccepted(nameOf(doc), doc);
  });
});

describe('emitted JSON Schema', () => {
  it.each(NAMES)('%s carries its $id and draft 2020-12', (name) => {
    const s = projectConfigJsonSchemas[name] as Doc;
    expect(s.$id).toBe(`https://forge.sidcorp.co/schemas/${name}-v1.json`);
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it.each(NAMES)('%s closes every object it declares properties for', (name) => {
    const open: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${at}/${i}`);
        });
        return;
      }
      if (!node || typeof node !== 'object') return;
      const n = node as Doc;
      if (n.properties && n.additionalProperties !== false) open.push(at || '/');
      for (const [k, v] of Object.entries(n)) walk(v, `${at}/${k}`);
    };
    walk(projectConfigJsonSchemas[name], '');
    expect(open).toEqual([]);
  });

  it('keys policy states by the dispatchable statuses, derived not listed', () => {
    const s = projectConfigJsonSchemas.policy as Doc;
    expect(s.properties.states.propertyNames.enum).toEqual([...POLICY_STATE_STATUSES]);
    expect([...POLICY_STATE_STATUSES].sort()).toEqual(['in_progress', 'needs_info', 'open']);
  });
});

describe('business rule: a key not in the schema is refused, never stripped', () => {
  const p = read('sim-forge-dev/project.json');
  const pol = read('sim-forge-dev/policy.json');
  const cases: [string, ProjectConfigSchemaName, (d: Doc) => void, string, string][] = [
    [
      'releaseModel',
      'project',
      (d) => {
        d.releaseModel = 'promote';
      },
      '',
      'releaseModel',
    ],
    [
      'repoPath',
      'project',
      (d) => {
        d.project.repoPath = '/srv/forge';
      },
      '/project',
      'repoPath',
    ],
    [
      'tags on project',
      'project',
      (d) => {
        d.project.tags = ['core'];
      },
      '/project',
      'tags',
    ],
    [
      'commitUrl',
      'project',
      (d) => {
        d.environments.dev.commitUrl = 'https://x/v';
      },
      '/environments/dev',
      'commitUrl',
    ],
    [
      'autoProdDeploy on deployment',
      'project',
      (d) => {
        d.environments.beta.deployment.autoProdDeploy = true;
      },
      '/environments/beta/deployment',
      'autoProdDeploy',
    ],
    [
      'mode on a state',
      'policy',
      (d) => {
        d.states.in_progress.mode = 'manual';
      },
      '/states/in_progress',
      'mode',
    ],
    [
      'gate on intake',
      'policy',
      (d) => {
        d.intake.gate = 'x';
      },
      '/intake',
      'gate',
    ],
  ];

  it.each(cases)('%s', (_n, schema, plant, path, key) => {
    const d = clone(schema === 'project' ? p : pol);
    plant(d);
    expectRefused(schema, d, { path, code: 'unrecognized_keys', key });
  });
});

describe('a deny entry is a tool pattern, to zod and to the emitted JSON Schema alike', () => {
  const withDeny = (entry: string): Doc => {
    const d = clone(read('sim-forge-dev/policy.json'));
    d.permissions.development.deny = [entry];
    return d;
  };

  it.each([
    'Bash(git push:*)',
    'CronCreate',
    'WebFetch(domain:example.com)',
    'mcp__playwright__*',
    'mcp__forge__forge_jobs_cancel',
  ])('accepts %s', (entry) => {
    expectAccepted('policy', withDeny(entry));
  });

  it.each(['bash', 'Bash()', 'Bash( git)', 'mcp__', 'mcp__forge__', 'projects.update'])(
    'refuses %s at its path',
    (entry) => {
      expectRefused('policy', withDeny(entry), { path: '/permissions/development/deny/0' });
    },
  );
});

describe("a project's description is one line of at most PROJECT_DESCRIPTION_MAX characters", () => {
  const described = (description: string): Doc => {
    const d = clone(read('sim-forge-dev/project.json'));
    d.project.description = description;
    return d;
  };

  it.each([
    'HOP (Hospital Operations Platform) là nền tảng vận hành bệnh viện — dữ liệu chỉ ở Việt Nam.', // i18n-allow: a description is the project's own prose, in its own language
    'x',
    'y'.repeat(PROJECT_DESCRIPTION_MAX),
  ])('accepts %s', (text) => {
    expectAccepted('project', described(text));
  });

  it.each([
    ['empty', ''],
    ['two lines', 'What it is.\nWhat it does.'],
    ['a leading space', ' What it is.'],
    ['a trailing space', 'What it is. '],
    ['one character too long', 'y'.repeat(PROJECT_DESCRIPTION_MAX + 1)],
  ])('refuses %s at /project/description', (_name, text) => {
    expectRefused('project', described(text), { path: '/project/description' });
  });
});
