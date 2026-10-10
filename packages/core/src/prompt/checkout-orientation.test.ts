import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../knowledge/index.js', () => ({ selectAlwaysInjectFromKnowledge: store.read }));

import {
  checkoutOrientation,
  ORIENTATION_GENERATED_LINE,
  servedCheckoutOrientation,
} from './checkout-orientation.js';
import { projectRulesText } from './facts/project-rules.js';
import { OPERATING_AFFORDANCES_TEXT } from './facts/registry.js';

const UI_COPY_RULE = {
  key: 'ui-copy-rule',
  text: 'Every person-facing page reads as state, not prose.\n\n1. A label is 1-3 words.\n',
};
const DELIVERY = { key: 'dev-delivery-checks', text: 'Prove each criterion once, red first.' };
const RULES = { entries: [UI_COPY_RULE, DELIVERY] };

describe('core serves the orientation a box writes into a checkout', () => {
  const body = checkoutOrientation('p-1', 'forge', RULES);

  it('opens the way the runner recognises a generated orientation (orientation.rs:is_generated)', () => {
    expect(body.startsWith('# Forge orientation — forge\n')).toBe(true);
    expect(body.split('\n').slice(0, 4)).toContain(ORIENTATION_GENERATED_LINE);
  });

  it('carries the one affordances table pipeline prompts carry, so the two cannot drift', () => {
    expect(body).toContain(OPERATING_AFFORDANCES_TEXT);
    expect(body.match(/## Operating affordances/g)).toHaveLength(1);
  });

  it('names its project, and is byte-identical for the same project and rules', () => {
    expect(body).toContain('**projectId:** `p-1`');
    expect(checkoutOrientation('p-1', 'forge', RULES)).toBe(body);
    expect(checkoutOrientation('p-2', 'forge', RULES)).not.toBe(body);
  });
});

describe('a run a master declares on a box reads the rules a core-built prompt carries (REQ-43 BC-12)', () => {
  it('carries every always-applied knowledge entry verbatim under its slug, in the order read', () => {
    const body = checkoutOrientation('p-1', 'forge', RULES);
    expect(body).toContain(`### ui-copy-rule\n${UI_COPY_RULE.text}`);
    expect(body).toContain(`### dev-delivery-checks\n${DELIVERY.text}`);
    expect(body.indexOf('### ui-copy-rule')).toBeLessThan(body.indexOf('### dev-delivery-checks'));
    expect(body.match(/## Project rules \(always applied\)/g)).toHaveLength(1);
  });

  it('renders the block the preamble renders, one heading level up', () => {
    const body = checkoutOrientation('p-1', 'forge', RULES);
    expect(body).toContain(projectRulesText(RULES.entries, 2).trimEnd());
    expect(projectRulesText([DELIVERY], 3)).toBe(
      '### Project rules (always applied)\n\nHard rules for this project — always-injected by the project owner. Follow them exactly.\n\n#### dev-delivery-checks\nProve each criterion once, red first.',
    );
    expect(body.endsWith('Prove each criterion once, red first.\n')).toBe(true);
  });

  it('carries no rules heading for a project with no always-applied entry', () => {
    const body = checkoutOrientation('p-1', 'forge', { entries: [] });
    expect(body).not.toContain('Project rules');
    expect(body.endsWith(`${OPERATING_AFFORDANCES_TEXT}\n`)).toBe(true);
  });

  it('says where to read the rules when the knowledge store could not be read', () => {
    const body = checkoutOrientation('p-1', 'forge', { unreadable: true });
    expect(body).toContain('## Project rules (always applied)');
    expect(body).toContain('could not be read');
    expect(body).toContain('`GET /api/projects/p-1/knowledge?injection=always`');
  });
});

describe('the orientation core serves reads the rules from the knowledge store', () => {
  beforeEach(() => store.read.mockReset());

  it("reads this project's always-applied entries", async () => {
    store.read.mockResolvedValue(RULES.entries);
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(store.read).toHaveBeenCalledWith('p-1');
    expect(body).toBe(checkoutOrientation('p-1', 'forge', RULES));
  });

  it('serves a named absence, not a failed read, when the store throws', async () => {
    store.read.mockRejectedValueOnce(new Error('connection refused'));
    const body = await servedCheckoutOrientation('p-1', 'forge');
    expect(body).toBe(checkoutOrientation('p-1', 'forge', { unreadable: true }));
  });
});
