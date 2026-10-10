import { describe, expect, it } from 'vitest';
import type { Linked } from './list-read.js';
import type { Row } from './read.js';
import { targetView } from './target-view.js';

const W = 'w1';
const linked = {
  workflows: new Map([
    [
      W,
      {
        flow: 'checkout',
        title: 'Checkout',
        steps: new Map([
          ['cart', 'Cart'],
          ['pay', 'Pay'],
          ['triaged', 'Triaged'],
        ]),
      },
    ],
  ]),
} as unknown as Linked;
const row = (over: Partial<Row>) =>
  ({ workflowId: W, stepId: null, edgeFrom: null, edgeTo: null, edgeLabel: null, ...over }) as Row;

describe('a workflow target names its step by the words the design gives it', () => {
  it('names the step an item is about', () => {
    expect(targetView(row({ stepId: 'triaged' }), linked)).toMatchObject({
      node: { step: 'triaged' },
      stepNames: { triaged: 'Triaged' },
    });
  });

  it('names both ends of the link an item is about', () => {
    expect(targetView(row({ edgeFrom: 'cart', edgeTo: 'pay' }), linked).stepNames).toEqual({
      cart: 'Cart',
      pay: 'Pay',
    });
  });

  it('leaves out a step the design no longer has, so it is read by its id', () => {
    expect(targetView(row({ stepId: 'gone' }), linked).stepNames).toEqual({});
  });

  it('carries no names for an item about the whole workflow', () => {
    expect(targetView(row({}), linked)).not.toHaveProperty('stepNames');
  });
});
