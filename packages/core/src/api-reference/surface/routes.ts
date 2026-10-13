import { Hono } from 'hono';
import pkg from '../../../package.json' with { type: 'json' };
import { describeOperation, raw } from '../declare/describe.js';
import { buildReference, type Reference } from '../document/build.js';
import type { RouteSource } from '../document/registry.js';
import { FLOWS } from './flows.js';
import { renderFlowsPage, renderReferencePage } from './page.js';

/**
 * The reference of an app, built from its route table on first use and kept: the table is fixed
 * once the app has finished mounting, and the first request comes after that.
 */
export function referenceOf(app: () => RouteSource): () => Promise<Reference> {
  let built: Promise<Reference> | null = null;
  return () => {
    built ??= buildReference(app(), { version: pkg.version });
    return built;
  };
}

/** The reference, served with no credential: the document, a page that renders it, and the flows. */
export function referenceRoutes(reference: () => Promise<Reference>): Hono {
  const routes = new Hono();

  routes.get(
    '/openapi.json',
    describeOperation({
      summary: 'The API reference as an OpenAPI 3.1 document',
      description:
        'Generated from the routes of the running app. It needs no credential and states, for every operation, its inputs, its answers and the access it needs.',
      responses: { 200: raw('application/json', 'The OpenAPI 3.1 document') },
    }),
    async (c) => c.json((await reference()).document),
  );

  routes.get(
    '/reference',
    describeOperation({
      summary: 'The API reference, rendered as a page',
      responses: { 200: raw('text/html', 'A page that renders /api/openapi.json') },
    }),
    (c) => c.html(renderReferencePage('/api/openapi.json')),
  );

  routes.get(
    '/reference/flows',
    describeOperation({
      summary: 'The order of calls for the flows an agent drives, as diagrams',
      responses: { 200: raw('text/html', 'A page of sequence diagrams') },
    }),
    async (c) => c.html(renderFlowsPage(FLOWS, (await reference()).document, '/api/reference')),
  );

  return routes;
}
