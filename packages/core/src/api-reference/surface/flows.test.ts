import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeOperation, json } from '../declare/describe.js';
import { buildReference } from '../document/build.js';
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

describe('the steps of each flow, read as sentences', () => {
  it('are each written as one: a capital to begin and a stop to end', () => {
    const notSentences = FLOWS.flatMap((f) =>
      f.steps
        .filter((s) => !/^[A-Z0-9].*[.!?]$/.test(s.note))
        .map((s) => `${f.id}: ${s.call}: ${s.note}`),
    );
    expect(notSentences).toEqual([]);
  });

  it('are listed on the page as a sentence after the summary, whatever case the note was written in', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:id']);
    const html = renderFlowsPage([flow], document, '/api/reference');
    expect(html).toContain(
      '<li><code>POST /api/pat</code> — POST /api/pat. Minted; secret once.</li>',
    );
    expect(html).toContain(
      '<li><code>GET /api/issues/:id</code> — GET /api/issues/:id. Allowed.</li>',
    );
  });

  it('are listed with no lowercase word after a full stop, on every real flow', async () => {
    const document = await documentWith(
      ...FLOWS.flatMap((f) =>
        f.steps.map((s): [string, string] => {
          const [method, path] = s.call.split(' ');
          return [method ?? '', path ?? ''];
        }),
      ),
    );
    const html = renderFlowsPage(FLOWS, document, '/api/reference');
    const items = [...html.matchAll(/<li>(.*)<\/li>/g)].map((m) =>
      (m[1] ?? '').replace(/<[^>]+>/g, ''),
    );
    expect(items.length).toBe(FLOWS.flatMap((f) => f.steps).length);
    expect(items.filter((text) => /[.!?] [a-z]/.test(text))).toEqual([]);
    expect(items.filter((text) => !/[.!?]$/.test(text))).toEqual([]);
  });
});

describe('the pages', () => {
  it('render the flows page with a diagram and the steps of each flow, escaped', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:id']);
    const html = renderFlowsPage([{ ...flow, title: 'A <b> & C' }], document, '/api/reference');
    expect(html).toMatch(/<pre class="mermaid"[^>]*>sequenceDiagram/);
    expect(html).toContain('A &lt;b&gt; &amp; C');
    expect(html).toContain('<code>POST /api/pat</code> — POST /api/pat');
    expect(html).toContain('href="/api/reference"');
  });

  it('keep each diagram at the size it is drawn, so a narrow screen scrolls it inside its own frame', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:id']);
    const html = renderFlowsPage([flow], document, '/api/reference');
    expect(html).toContain('sequence: { useMaxWidth: false }');
    expect(html).toContain('overflow-x: auto; max-width: 100%');
    expect(html).toContain('scroll it sideways');
    expect(html).toContain('new ResizeObserver(showWhereWider)');
    expect(html).toContain('tabindex="0"');
  });

  it('name an icon on both pages, so the browser does not ask the host for /favicon.ico', async () => {
    const document = await documentWith(['POST', '/api/pat'], ['GET', '/api/issues/:id']);
    expect(renderReferencePage('/api/openapi.json')).toContain('<link rel="icon" href="data:,">');
    expect(renderFlowsPage([flow], document, '/api/reference')).toContain(
      '<link rel="icon" href="data:,">',
    );
  });

  it('load the renderers from a pinned version with the hash of the file read', () => {
    const html = renderReferencePage('/api/openapi.json');
    expect(html).toMatch(/@scalar\/api-reference@\d+\.\d+\.\d+\//);
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(html).toContain('data-url="/api/openapi.json"');
  });
});
