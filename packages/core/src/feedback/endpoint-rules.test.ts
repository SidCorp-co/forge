// ISS-279 / FB-91: an item about Autoflow's MCP tool `save_backend_workflow` could only be a Screen.
// An `endpoint` target names a route or tool the project serves, checked against its contracts'
// current versions, and counts as a target like the other five.

import { describe, expect, it } from 'vitest';
import type { ContractVersionFact } from '../lib/contract-versions.js';
import { endpointIn, servedFrom } from './endpoint-rules.js';
import { targetCountRefusal } from './rules.js';

const version = (over: Partial<ContractVersionFact>): ContractVersionFact => ({
  providerProjectId: 'p',
  contractSlug: 'shop-tools',
  version: '1.0.0',
  approval: 'approved',
  contractType: 'mcp-tools',
  elements: [],
  artifactSha256: null,
  breakingElements: [],
  ...over,
});

const served = servedFrom([
  version({
    elements: [
      'save_backend_workflow',
      'save_backend_workflow/properties/graph',
      'list_backend_routes',
    ],
  }),
  version({ contractSlug: 'admin-tools', version: '2.0.0', elements: ['list_backend_routes'] }),
  version({ contractSlug: 'shop-api', contractType: 'openapi', elements: ['GET /pets'] }),
  version({ contractSlug: 'events', contractType: 'json-schema', elements: ['#/$defs/Order'] }),
  version({ contractSlug: 'unindexed', elements: null }),
]);

describe('the served set', () => {
  it('holds the routes of openapi and the tools of mcp-tools, by key, and nothing else', () => {
    expect(served.map((s) => s.key)).toEqual([
      'admin-tools:list_backend_routes',
      'shop-api:GET /pets',
      'shop-tools:list_backend_routes',
      'shop-tools:save_backend_workflow',
    ]);
  });
});

describe('naming an endpoint', () => {
  it('finds a tool by its bare name where one contract serves it', () => {
    expect(endpointIn(served, ' save_backend_workflow ', '/endpoint')).toEqual({
      key: 'shop-tools:save_backend_workflow',
      contract: 'shop-tools',
      version: '1.0.0',
      type: 'mcp-tools',
      element: 'save_backend_workflow',
    });
  });

  it('finds a route as METHOD /path, and any name as <contract>:<element>', () => {
    expect(endpointIn(served, 'GET /pets', '/endpoint')).toMatchObject({
      key: 'shop-api:GET /pets',
    });
    expect(endpointIn(served, 'admin-tools:list_backend_routes', '/endpoint')).toMatchObject({
      contract: 'admin-tools',
    });
  });

  it('refuses a bare name two contracts serve, naming both', () => {
    const r = endpointIn(served, 'list_backend_routes', '/endpoint');
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_NOT_ONE', path: '/endpoint' });
    expect('detail' in r && r.detail).toContain(
      'admin-tools:list_backend_routes, shop-tools:list_backend_routes',
    );
  });

  it('refuses a name it does not serve, naming what it does', () => {
    for (const name of [
      'save_backend_flow',
      'save_backend_workflow/properties/graph',
      '#/$defs/Order',
    ]) {
      const r = endpointIn(served, name, '/endpoint');
      expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/endpoint' });
      expect('detail' in r && r.detail).toContain('shop-tools:save_backend_workflow');
    }
  });

  it('says a project serving nothing provides no contract, and how to declare one', () => {
    const r = endpointIn([], 'save_backend_workflow', '/endpoint');
    expect(r).toMatchObject({ code: 'FEEDBACK_TARGET_UNKNOWN', path: '/endpoint' });
    expect('detail' in r && r.detail).toMatch(/provides no openapi or mcp-tools contract/);
  });

  it('lists at most twenty names and says how many more there are', () => {
    const many = servedFrom([
      version({
        elements: Array.from({ length: 25 }, (_, i) => `tool_${String(i).padStart(2, '0')}`),
      }),
    ]);
    const r = endpointIn(many, 'nope', '/endpoint');
    expect('detail' in r && r.detail).toContain('and 5 more');
    expect('detail' in r && r.detail).not.toContain('tool_20');
  });
});

describe('a endpoint is a target', () => {
  it('is one target alone, and two beside any other', () => {
    expect(targetCountRefusal({ endpoint: 'GET /pets' }, undefined)).toBeNull();
    for (const other of ['requirement', 'issue', 'release', 'workflow', 'screen'] as const) {
      expect(targetCountRefusal({ endpoint: 'GET /pets', [other]: 'x' }, undefined)).toMatchObject({
        code: 'FEEDBACK_TARGET_NOT_ONE',
      });
    }
  });

  it('names endpoint among the targets when none is named', () => {
    expect(targetCountRefusal({}, undefined)?.detail).toContain(
      'requirement, issue, release, workflow, endpoint or screen',
    );
  });
});
