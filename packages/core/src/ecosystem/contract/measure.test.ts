import { describe, expect, it } from 'vitest';
import { exampleProblem, indexContract } from './elements.js';
import { ArtifactUnreadable, elementList, measureChange, parseArtifact } from './measure.js';

const tools = (inputSchema: object) =>
  JSON.stringify({ tools: [{ name: 'forge_issues.get', description: 'd', inputSchema }] });
const ISSUE = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1 } },
  required: ['id'],
};

describe('a contract with no differ, or no artifact, measures unknown and never non-breaking', () => {
  it.each(['opaque', 'asyncapi', 'graphql', 'protobuf'])(
    '%s → unknown with the reason',
    async (type) => {
      const d = await measureChange(type, 'a', 'b');
      expect(d.classification).toBe('unknown');
      expect(d.changes[0]?.text).toMatch(/no differ/);
    },
  );

  it('a tools contract is measured by the narrow rules', async () => {
    const d = await measureChange(
      'mcp-tools',
      tools(ISSUE),
      tools({
        ...ISSUE,
        required: ['id', 'scope'],
        properties: { ...ISSUE.properties, scope: { type: 'string' } },
      }),
    );
    expect(d).toMatchObject({
      tool: 'json-schema-diff',
      toolVersion: 'forge-narrow-1',
      classification: 'breaking',
    });
  });
});

describe('an artifact core cannot read is refused by name, not measured as empty', () => {
  it.each([
    ['openapi', '{not json', /does not parse/],
    ['openapi', '{"paths":{}}', /this one names none/],
    ['mcp-tools', '{"tools":[{"name":"x"}]}', /inputSchema/],
  ])('%s %s', (type, text, why) => {
    expect(() => parseArtifact(type, text)).toThrow(ArtifactUnreadable);
    expect(() => parseArtifact(type, text)).toThrow(why);
  });

  it('an opaque or unindexed type keeps no element list', () => {
    expect(elementList('opaque', null)).toBeNull();
    expect(elementList('mcp-tools', JSON.parse(tools(ISSUE)))).toEqual(['forge_issues.get']);
  });
});

describe('an example is checked against the schema of its element in the cited version (EXAMPLE_NOT_IN_CONTRACT)', () => {
  const mcp = indexContract('mcp-tools', JSON.parse(tools(ISSUE)));
  const api = indexContract('openapi', {
    openapi: '3.1.0',
    paths: {
      '/api/issues/{id}': {
        patch: {
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { title: { type: 'string', maxLength: 5 } } },
              },
            },
          },
          responses: { default: { description: 'undeclared' } },
        },
      },
    },
  });

  it('passes a payload the schema takes', () => {
    expect(
      exampleProblem(mcp, {
        element: 'forge_issues.get',
        direction: 'tool-input',
        payload: { id: 'ISS-1' },
      }),
    ).toBeNull();
    expect(
      exampleProblem(api, {
        element: 'PATCH /api/issues/{id}',
        direction: 'request',
        payload: { title: 'ok' },
      }),
    ).toBeNull();
  });

  it.each([
    [
      'a payload the schema refuses',
      { element: 'forge_issues.get', direction: 'tool-input', payload: { id: '' } },
      /does not match the schema of forge_issues\.get: \/id/,
    ],
    [
      'an element the version does not have',
      { element: 'forge_gone', direction: 'tool-input', payload: {} },
      /not an element/,
    ],
    [
      'a direction the contract does not describe',
      { element: 'forge_issues.get', direction: 'tool-output', payload: {} },
      /describes each tool's input/,
    ],
  ] as const)('refuses %s', (_n, ex, why) => {
    expect(exampleProblem(mcp, ex)?.detail).toMatch(why);
  });

  it('refuses a response example where the version declares no response schema, rather than wave it through', () => {
    expect(
      exampleProblem(api, {
        element: 'PATCH /api/issues/{id}',
        direction: 'response',
        status: 200,
        payload: {},
      })?.detail,
    ).toMatch(/declares no JSON response schema for 200/);
    expect(
      exampleProblem(api, {
        element: 'PATCH /api/issues/{id}',
        direction: 'request',
        payload: { title: 'too long' },
      })?.detail,
    ).toMatch(/\/title/);
  });
});
