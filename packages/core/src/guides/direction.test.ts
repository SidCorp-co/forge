// @direct-test-of packages/core/src/guides/
// @direct-test-of packages/core/src/prompt/facts/registry.ts
// @direct-test-of packages/core/src/prompt/state-prompts/release-batch.ts
// The owner's direction of 2026-11-07 (ISS-1057), as the texts core serves teach it: the loop is
// Product → Delivery → Release → Audit → Product, agents decide and execute on the record, and a
// person is asked only for what a person owns (irreversible, real money, credentials, product direction,
// policy). Each
// served text is read as a reader gets it, so a sentence put back in its old shape goes red here.

import { describe, expect, it } from 'vitest';
import { renderFact } from '../prompt/facts/registry.js';
import { releaseBatchStatePrompt } from '../prompt/state-prompts/release-batch.js';
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
      'A decision only a person owns — irreversible, real money, credentials, product direction, standing policy',
      'Any other decision is yours: make it and record it.',
    ])
      expect(guide).toContain(said);
    for (const gone of ['An open question needing a human decision', 'pending sign-off'])
      expect(guide).not.toContain(gone);
  });

  it('the lifecycle guide keeps needs_decision for what only a person owns', async () => {
    const guide = await served('pipeline-and-issue-lifecycle');
    expect(guide).toContain(
      'a person must decide what only a person owns: an irreversible act, real money, product direction, standing policy',
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
      'a decision only a person owns — irreversible, real money, product direction, standing policy',
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

describe('Audit is its own job, and what it finds goes back to Product', () => {
  it('the cleanup-audit guide is the Audit stage and returns findings to Product and lessons', async () => {
    const guide = await served('cleanup-audit');
    for (const said of [
      "Forge's loop is Product → Delivery → Release → Audit → Product, and this is Audit: a job of its own, never a step of delivery.",
      "Audit runs in the project's cleanup window, after a period of running",
      '### 3. Read how it ran',
      'wrong answers, the same question asked again, a fix that was slow to come',
      '**Patterns that no longer fit.**',
      'is Feedback (`POST /api/projects/:id/feedback`), for the next Product round to triage',
      'is kept for retrieval: `POST /api/memory`',
    ])
      expect(guide).toContain(said);
    expect(guide).not.toContain('development, not cleanup: leave it as debt with what you found');
  });

  it('fast delivery ends at the landing and the release, and hands Audit to the cleanup run', async () => {
    const guide = await served('fast-delivery');
    expect(guide).toContain('### The cleanup run: Audit');
    expect(guide).toContain('### Nothing waits on Audit');
    expect(guide).toContain(
      'No landing waits on a cleanup report, and no promotion or release does either',
    );
    expect(guide).toContain('A change rated high lands as any other does');
    expect(guide).not.toContain('MERGE_CLEANUP_PENDING');
    expect(guide).not.toContain('RELEASE_CLEANUP_PENDING');
    expect(guide).not.toContain('waits for a green cleanup');
    expect(guide).toContain('returns what would change the product to Product as Feedback');
  });
});

describe('a person’s act that is a kernel step is described as that and nothing more', () => {
  it('deploy safety names the production confirm as the kernel’s step where production does not deploy on land', async () => {
    const guide = await served('deploy-safety');
    expect(guide).toContain(
      "Where the project's production does not deploy on land, a deploy reaching production parks on its run until a person confirms it.",
    );
    expect(guide).not.toContain("release stage's human-confirm gate");
  });
});

describe('an issue is admitted to the backlog a master works, and stays whole', () => {
  it('open admits to the backlog the master builds, in every guide that says what open does', async () => {
    for (const slug of ['agent-setup', 'pipeline-and-issue-lifecycle']) {
      const guide = await served(slug);
      expect(guide, slug).not.toContain('auto-triages');
      expect(guide, slug).not.toContain('spawns a pipeline run');
    }
    expect(await served('agent-setup')).toContain(
      "admits the issue to the backlog: the project's master is woken and builds it in its next batch or wave",
    );
  });

  it('an oversized issue is built whole and released once, never split across releases', async () => {
    const guide = await served('issue-dependencies');
    expect(guide).toContain('It stays one issue.');
    expect(guide).toContain('one issue is never split across releases');
    expect(guide).not.toContain('When a half genuinely ships on its own');
    expect(guide).not.toContain('Recording a note without triggering a pipeline run');
  });
});

describe('a release run hands a person only what a person owns', () => {
  it('names a credential, an access grant or a decision only a person owns as the blocker it owes a human', () => {
    const prompt = flat(releaseBatchStatePrompt);
    expect(prompt).toContain(
      'a decision only a person owns (irreversible, real money, product direction)',
    );
    expect(prompt).not.toMatch(/an access grant, a decision — say so/);
  });
});

describe('verdicts come from the judge after landing, unless a gate holds them before', () => {
  it('issue-flow names the release_criteria gate as the only place verdicts are owed before the merge', async () => {
    const guide = await served('issue-flow');
    expect(guide).toContain(
      "where the project's gate `release_criteria` is enforced (`strict`, or `delivery.verdictsRequired` under `standard`), the verdicts are owed before the merge or the cut",
    );
    expect(guide).toContain("elsewhere the batch's one judge records them once it has landed");
    expect(guide).not.toContain('Verdicts are owed before the merge, never after it');
  });

  it('pipeline rules say a recorded landing refuses no landing that happened', () => {
    const rules = flat(renderFact('pipeline-rules'));
    expect(rules).toContain('refuses no landing that happened');
    expect(rules).not.toContain(
      'asks a pass on each live criterion judged at the very commit it records',
    );
  });
});

describe('a served guide names REST, never a command of the plugin CLI', () => {
  it('names no `forge` CLI command in the guides that once did', async () => {
    for (const slug of [
      'project-settings-and-test-credentials',
      'memory-and-knowledge',
      'deploy-safety',
      'attachments-and-uploads',
      'agent-setup',
    ]) {
      const guide = await served(slug);
      expect(guide, slug).not.toMatch(
        /`forge (knowledge|coolify|attach|issue|new|comment|guide)\b/,
      );
    }
    expect(await served('agent-setup')).toContain('`GET /api/projects/:id/gates`');
  });
});

describe('Audit does not gate delivery', () => {
  it('issue-flow and the Audit guide hold no landing or promotion on a cleanup report', async () => {
    const flow = await served('issue-flow');
    expect(flow).toContain('no landing and no promotion waits on a cleanup report');
    expect(flow).not.toContain('MERGE_CLEANUP_PENDING');
    const audit = await served('cleanup-audit');
    expect(audit).toContain('Delivery never waits on it');
    expect(audit).not.toContain('when a change rated high waits');
  });
});

// Round 2 of ISS-1057 (owner deltas, 2026-11-07): an issue is one verifiable outcome; each defect
// seen has one place (the fix, the debt ledger, its owner); an issue closes when its criteria are
// met in scope, and released and confirmed are marks on the release.
describe('an issue is one outcome, and each defect seen has one place', () => {
  it('what-is-an-issue files a separate issue only for priority, handoff or independent tracking', async () => {
    const guide = await served('what-is-an-issue');
    expect(guide).toContain('An issue is **one verifiable outcome**');
    expect(guide).toContain(
      'A separate issue is filed only for one of three reasons: **priority** (a part must go ahead of, or wait behind, other work), **handoff**',
    );
    expect(guide).toContain('A step, a layer or a file set is none of those.');
    expect(guide).not.toContain('An issue is a unit of **work**');
  });

  it('what-is-an-issue sends a standalone defect to the debt ledger, never into the fix', async () => {
    const guide = await served('what-is-an-issue');
    expect(guide).toContain('| **Debt for Audit** |');
    expect(guide).toContain('`POST /api/projects/:id/debts`');
    expect(guide).toContain('Cleanup the fix does not need is not this.');
    expect(guide).not.toContain('In reach here** → usually cheapest to fix it');
    expect(guide).not.toContain('a defect in what the issue you are working already touches');
  });

  it('writing-an-issue writes one outcome', async () => {
    const guide = await served('writing-an-issue');
    expect(guide).toContain('**Write one outcome.**');
    expect(guide).toContain(
      'that is when the issue closes, and what it cannot meet is moved out on the record first',
    );
  });

  it('the lifecycle guide keeps three marks apart, and its holder closes an issue met in scope', async () => {
    const guide = await served('pipeline-and-issue-lifecycle');
    expect(guide).toContain(
      '**Three marks, kept apart.** An issue closes when its criteria are met in scope. Released, and confirmed on the target environment, are marks on the release — never issue statuses',
    );
    expect(guide).toContain('"is it live" is read from the release record');
    expect(guide).toContain('the close names where each one went');
    expect(guide).toContain('The run holding the issue closes it from `awaiting_release`');
    expect(guide).toContain('(`CLOSE_CRITERION_UNPLACED`)');
    expect(guide).not.toContain("Today the kernel still makes a close the release's act");
    expect(guide).not.toContain('CLOSE_ONLY_BY_RELEASE`, the `closed` row below');
    expect(guide).not.toContain('**`closed` means the work shipped');
    expect(guide).not.toContain('`closed` claims the work shipped');
  });

  it('the orientation every prompt carries routes a standalone defect to the debt ledger', () => {
    const table = flat(renderFact('pipeline-rules'));
    expect(table).toContain('debt for the Audit, `projects/<id>/debts -X POST` with its evidence');
    expect(table).not.toContain('`closed` says it shipped');
  });

  it('the dispatch guide splits nothing for size, and a holder closes met in scope', async () => {
    const guide = await served('dispatch');
    expect(guide).not.toContain('split it before dispatch where it is more than one run');
    expect(guide).toContain('its size is no reason to split it');
    expect(guide).toContain('only for priority, a handoff or independent tracking');
    expect(guide).not.toContain("Today the kernel still makes the close a release's act");
    expect(guide).toContain('The run holding an issue closes it, each criterion it did');
    expect(guide).toContain('is checked wide early, before the landing');
  });

  it('the conformance guide runs verify as the batch’s wide check and gives every red a place', async () => {
    const guide = await served('conformance-and-verify');
    expect(guide).not.toContain('Run it **before you report a step complete**');
    expect(guide).not.toContain('In reach and inside your ownership line** — fix it');
    expect(guide).toContain('**Verify is a wide check**: it runs once per batch');
    expect(guide).toContain('**It stands alone** — record it as debt for the Audit');
    expect(guide).toContain('a red recorded on the debt ledger is discharged to the Audit');
  });

  it('the release prompt writes the release mark, and closes what its holders had not', () => {
    const prompt = flat(releaseBatchStatePrompt);
    expect(prompt).not.toContain('`finish` is the ONLY thing in Forge that writes `closed`');
    expect(prompt).toContain(
      "`finish` writes the release's mark — this batch was released — on the release record",
    );
    expect(prompt).not.toContain('the only thing in Forge that writes `closed`');
    expect(prompt).toContain('it closes the issues it claimed that their holders had not closed');
    expect(prompt).toContain('Confirmed on the target environment is a separate mark');
  });
});
