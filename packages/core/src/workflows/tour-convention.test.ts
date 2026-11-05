// @direct-test-of packages/core/src/guides/workflow-templates-guide.ts
// The product-tour convention the templates guide teaches (ISS-582) is drawable in ux-flow@1 as it
// stands: a tour per persona, drawn with ENTRY, SCREEN, USER_ACTION and EXIT, passes the template.

import { uxFlow } from '@forge/contracts/workflow-template-behaviour';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TEMPLATES_GUIDE } from '../guides/workflow-templates-guide.js';
import type { WorkflowWriteV2 } from './schema.js';
import { templateRefusals } from './template-check.js';
import { EXAMPLE_BOARD, head, lane, step } from './template-example-kit.js';

const tourStep = (persona: string, label: string, route: string) => ({
  type: 'SCREEN',
  label,
  persona,
  route,
  wireframe: { attachment: EXAMPLE_BOARD },
  actions: ['next', 'skip'],
});

/** A two-role tour drawn exactly as the guide's Product tours bullet says. */
const tour = (): WorkflowWriteV2 => ({
  ...head(
    'first-visit-tour',
    'flow',
    'First visit tour',
    'A short tour on the first visit.',
    'ux-flow',
  ),
  personas: [lane('buyer', 'Buyer'), lane('seller', 'Seller')],
  steps: [
    step('buyer-start', 'A buyer signs in for the first time.', [], {
      type: 'ENTRY',
      label: 'Tour: first visit',
    }),
    step(
      'buyer-1',
      'The tour points at the search box.',
      ['buyer-start'],
      tourStep('buyer', 'Search', '/shop?tour=1'),
    ),
    step('buyer-1-next', 'The buyer moves on.', ['buyer-1'], {
      type: 'USER_ACTION',
      label: 'next',
    }),
    step('buyer-1-skip', 'The buyer skips the tour.', ['buyer-1'], {
      type: 'USER_ACTION',
      label: 'skip',
    }),
    step(
      'buyer-2',
      'The tour points at the cart.',
      ['buyer-1-next'],
      tourStep('buyer', 'Cart', '/cart?tour=2'),
    ),
    step('buyer-2-next', 'The buyer finishes.', ['buyer-2'], {
      type: 'USER_ACTION',
      label: 'next',
    }),
    step('buyer-2-skip', 'The buyer skips the tour.', ['buyer-2'], {
      type: 'USER_ACTION',
      label: 'skip',
    }),
    step('seller-start', 'A seller signs in for the first time.', [], {
      type: 'ENTRY',
      label: 'Tour: first visit',
    }),
    step(
      'seller-1',
      'The tour points at the listings.',
      ['seller-start'],
      tourStep('seller', 'Listings', '/listings?tour=1'),
    ),
    step('seller-1-next', 'The seller finishes.', ['seller-1'], {
      type: 'USER_ACTION',
      label: 'next',
    }),
    step('seller-1-skip', 'The seller skips the tour.', ['seller-1'], {
      type: 'USER_ACTION',
      label: 'skip',
    }),
    step('done', 'The tour ends.', ['buyer-2-next', 'seller-1-next'], {
      type: 'EXIT',
      label: 'Tour done',
    }),
    step('skipped', 'The tour is left early.', ['buyer-1-skip', 'buyer-2-skip', 'seller-1-skip'], {
      type: 'EXIT',
      label: 'Tour skipped',
    }),
  ],
});

const refusalsOf = (doc: WorkflowWriteV2) =>
  templateRefusals(doc, uxFlow, { templates: [uxFlow], designs: new Map() });

describe('the product-tour convention (ISS-582)', () => {
  it('is taught by the templates guide', () => {
    expect(WORKFLOW_TEMPLATES_GUIDE.body).toContain('**Product tours.**');
    expect(WORKFLOW_TEMPLATES_GUIDE.body).toContain('?tour=<n>');
  });

  it('a two-role tour drawn by it passes ux-flow@1 with no new node type', () => {
    expect(refusalsOf(tour())).toEqual([]);
  });

  it('two tour steps on one route without ?tour=<n> are refused, which is why the convention adds it', () => {
    const doc = tour();
    const second = doc.steps.find((s) => s.id === 'buyer-2');
    if (second?.node) (second.node as { route: string }).route = '/shop?tour=1';
    expect(refusalsOf(doc).length).toBeGreaterThan(0);
  });
});
