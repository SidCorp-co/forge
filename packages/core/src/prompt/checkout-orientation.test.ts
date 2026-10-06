import { describe, expect, it } from 'vitest';
import { checkoutOrientation, ORIENTATION_GENERATED_LINE } from './checkout-orientation.js';
import { OPERATING_AFFORDANCES_TEXT } from './facts/registry.js';

describe('core serves the orientation a box writes into a checkout', () => {
  const body = checkoutOrientation('p-1', 'forge');

  it('opens the way the runner recognises a generated orientation (orientation.rs:is_generated)', () => {
    expect(body.startsWith('# Forge orientation — forge\n')).toBe(true);
    expect(body.split('\n').slice(0, 4)).toContain(ORIENTATION_GENERATED_LINE);
  });

  it('carries the one affordances table pipeline prompts carry, so the two cannot drift', () => {
    expect(body).toContain(OPERATING_AFFORDANCES_TEXT);
    expect(body.match(/## Operating affordances/g)).toHaveLength(1);
  });

  it('names its project, and is byte-identical for the same project', () => {
    expect(body).toContain('**projectId:** `p-1`');
    expect(checkoutOrientation('p-1', 'forge')).toBe(body);
    expect(checkoutOrientation('p-2', 'forge')).not.toBe(body);
  });
});
