// @direct-test-of packages/core/src/guides/
// @direct-test-of packages/core/src/prompt/facts/registry.ts
// The owner's direction of 2026-11-07 (ISS-1057), as the texts core serves teach it: the loop is
// Product → Delivery → Release → Audit → Product, agents decide and execute on the record, and a
// person is asked only for what a person owns (money, credentials, product direction, policy). Each
// served text is read as a reader gets it, so a sentence put back in its old shape goes red here.

import { describe, expect, it } from 'vitest';
import { renderFact } from '../prompt/facts/registry.js';
import { guideRoutes } from './routes.js';

async function served(slug: string): Promise<string> {
  const res = await guideRoutes.request(`/guides/${slug}.md`);
  expect(res.status, `guide ${slug} is not served`).toBe(200);
  return (await res.text()).replace(/\s+/g, ' ');
}

const flat = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ');

describe('a decision inside the work is the agent’s, never parked on a person', () => {
  it('what-is-an-issue sends only a decision a person owns to needs_decision', async () => {
    const guide = await served('what-is-an-issue');
    for (const said of [
      'A decision inside the work — a tradeoff, a scope call, a choice between two designs | yours | make it, and record the choice',
      'A decision only a person owns — money, credentials, product direction, standing policy',
      'Any other decision is yours: make it and record it.',
    ])
      expect(guide).toContain(said);
    for (const gone of ['An open question needing a human decision', 'pending sign-off'])
      expect(guide).not.toContain(gone);
  });

  it('the lifecycle guide keeps needs_decision for what only a person owns', async () => {
    const guide = await served('pipeline-and-issue-lifecycle');
    expect(guide).toContain(
      'a person must decide what only a person owns: money, product direction, standing policy',
    );
    expect(guide).toContain(
      'A tradeoff or a scope call inside agreed work is not: the agent decides it',
    );
    expect(guide).not.toContain('(a tradeoff, a scope call, an approval)');
    expect(guide).not.toContain('a tradeoff awaiting a call are both');
  });

  it('every pipeline prompt says a tradeoff is the agent’s to decide', () => {
    const rules = flat(renderFact('pipeline-rules'));
    expect(rules).toContain('A tradeoff or a scope call inside the work is yours');
    expect(rules).toContain(
      'a decision only a person owns — money, product direction, standing policy',
    );
    expect(rules).not.toContain('a decision between tradeoffs');
  });

  it('the requirement guide names the master as the approver outside strict', async () => {
    const guide = await served('requirement-lifecycle');
    expect(guide).toContain("outside a strict profile, the project's master and its checklist");
    expect(guide).not.toContain('puts the draft in front of whoever approves it');
  });

  it('the feedback guide reads a stored status as an act, not a person’s decision', async () => {
    const guide = await served('feedback-triage');
    expect(guide).toContain('Each stored status is written by an act, never derived');
    expect(guide).not.toContain("Each stored status is a person's decision");
    expect(guide).not.toContain('waits on a person to route it anew');
  });
});
