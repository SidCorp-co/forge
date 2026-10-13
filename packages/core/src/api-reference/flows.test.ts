import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildReference } from './build.js';
import { describeOperation, json } from './describe.js';
import { checkFlows, FLOWS, type Flow, operationOfStep, toMermaid } from './flows.js';
import { renderFlowsPage, renderReferencePage } from './page.js';

async function documentWith(...routes: Array<[string, string]>) {
  const app = new Hono();
  for (const [method, path] of routes) {
    app.on(
      method,
      path,
      describeOperation({ summary: `${method} ${path}`, responses: { 200: json(z.object({})) } }),
      (c) => c.json({}),
    );
  }
  return (await buildReference(app, { version: 't' })).document;
}

const flow: Flow = {
  id: 'f',
  title: 'F',
  summary: 's',
  steps: [
    { from: 'Person', call: 'POST /api/pat', note: 'minted; secret once' },
    { from: 'Agent', call: 'GET /api/issues/:id', note: 'allowed' },
  ],
};

describe('checkFlows', () => {
  it('finds every step that names an operation the document has, whatever the parameter is called', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:issueId']);
    expect(checkFlows(document, [flow])).toEqual([]);
  });

  it('names the flow, the step and the call of a step whose route is gone', async () => {
    const document = await documentWith(['POST', '/api/pat']);
    expect(checkFlows(document, [flow])).toEqual([
      { flow: 'f', step: 2, call: 'GET /api/issues/:id' },
    ]);
  });

  it('does not find a step under a different method than the route serves', async () => {
    const document = await documentWith(['GET', '/api/pat'], ['GET', '/api/issues/:id']);
    expect(checkFlows(document, [flow]).map((m) => m.call)).toEqual(['POST /api/pat']);
  });

  it('reads the operation a step names', async () => {
    const document = await documentWith(['POST', '/api/pat']);
    expect(operationOfStep(document, 'POST /api/pat')?.summary).toBe('POST /api/pat');
    expect(operationOfStep(document, 'DELETE /api/pat')).toBeNull();
  });
});

describe('the flows an agent drives', () => {
  it('are the four the issue names, each with steps', () => {
    expect(FLOWS.map((f) => f.id)).toEqual([
      'pair-a-runner',
      'claim-and-finish-a-job',
      'move-an-issue',
      'grant-and-use-a-token',
    ]);
    expect(FLOWS.every((f) => f.steps.length >= 4)).toBe(true);
  });

  it('draw a sequence with one call and one answer per step', () => {
    const diagram = toMermaid(flow);
    expect(diagram.split('\n')[0]).toBe('sequenceDiagram');
    expect(diagram).toContain('Person->>Core: 1. POST /api/pat');
    expect(diagram).toContain('Core-->>Agent: allowed');
  });

  it('keep a semicolon out of a note, which a diagram reads as the end of a statement', () => {
    expect(
      toMermaid({ ...flow, steps: [{ from: 'Agent', call: 'GET /x', note: 'a; b' }] }),
    ).toContain('Core-->>Agent: a, b');
  });
});

describe('the pages', () => {
  it('render the flows page with a diagram and the steps of each flow, escaped', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:id']);
    const html = renderFlowsPage([{ ...flow, title: 'A <b> & C' }], document, '/api/reference');
    expect(html).toContain('<pre class="mermaid">sequenceDiagram');
    expect(html).toContain('A &lt;b&gt; &amp; C');
    expect(html).toContain('<code>POST /api/pat</code> — POST /api/pat');
    expect(html).toContain('href="/api/reference"');
  });

  it('load the renderers from a pinned version with the hash of the file read', () => {
    const html = renderReferencePage('/api/openapi.json');
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//);
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(html).toContain('data-url="/api/openapi.json"');
  });
});
