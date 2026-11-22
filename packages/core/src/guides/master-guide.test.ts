// The forge-master skill is a map (ISS-1251): the runner ships the role, the goal and what a pass
// owes, and points at what the core its box talks to serves — the master's map rendered from the
// cards, each door's card, and the method (`dispatch`, `forge-master`, `issue-flow`). What the skill
// used to say is pinned here on what is served now, so a teaching the move dropped goes red by name,
// and the skill growing a method again goes red too.
// @direct-test-of packages/runner/crates/runner-workspace/assets/forge-master-skill.md

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import type { GuideSlug } from './guide-ref.js';
import { getGuide } from './registry.js';
import { guideRoutes } from './routes.js';
import { servedGuideBody } from './served.js';

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });

const flat = (text: string) => text.split(/\s+/).join(' ');
const SKILL = readFileSync(
  new URL('../../../runner/crates/runner-workspace/assets/forge-master-skill.md', import.meta.url),
  'utf8',
);
const served = (slug: GuideSlug) => {
  const guide = getGuide(slug);
  if (!guide) throw new Error(`no guide ${slug}`);
  return flat(servedGuideBody(guide));
};
const MASTER = served('forge-master');
const DISPATCH = served('dispatch');

describe('the master skill is a map, its method served by core (ISS-1251)', () => {
  it('points at its map, the cards and the method, and holds no method of its own', () => {
    for (const pointer of [
      "`forge-runner api 'guides/doors.md?audience=master'`",
      "`forge-runner api 'guides/doors.md?door=<the door>'`",
      '`dispatch`',
      '`forge-master`',
      '`issue-flow`',
    ]) {
      expect(SKILL).toContain(pointer);
    }
    for (const method of [
      '## Direct mode',
      '## What is yours and nowhere else',
      '## Declare a run before you dispatch it',
      'QUESTION_MERGE_IS_ORDERING',
      'RUN_SLOT_UNAVAILABLE',
    ]) {
      expect(SKILL, `the skill holds ${method} again`).not.toContain(method);
    }
    // the 33 KB the runner shipped before, read on every pass
    expect(SKILL.length).toBeLessThan(10_000);
  });

  it('serves the master its map, rendered from the cards', async () => {
    const res = await guideRoutes.request('/guides/doors.md?audience=master');
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page.startsWith('# Your map (master)')).toBe(true);
    expect(page).toMatch(/^- when .+ → /m);
    const both = await guideRoutes.request(
      `/guides/doors.md?audience=master&door=${encodeURIComponent('POST /api/questions')}`,
    );
    expect(both.status).toBe(400);
  });

  it('the forge-master guide carries what is the master’s own, and the cards of the doors it acts through', () => {
    for (const word of [
      // a mark names what landed
      '`artifacts`',
      '`[{surface, ref, change}]`',
      '`design`',
      '`commit`',
      // a release note in the content language, titled, and a release named
      '`releaseNotes.userFacing`',
      '/content-language',
      '`releaseNotes.title`',
      '`releaseNotes.adminSteps`',
      '/naming -X PUT',
      // ordering is a blocks edge; a park names what it waits on, from the cards beneath
      '**Ordering between issues is a blocks edge, never a park.**',
      "Another project's work is a contract wait on its version, never an edge to its issue: `POST /api/issues/:id/contract-waits { contract, minVersion, reason?, dueAt? }`",
      'only for an act a person owes',
      '`QUESTION_MERGE_IS_ORDERING`',
      '`"awaitsMerge":{"issueId":"<id>"}`',
      '`QUESTION_MERGE_ALREADY_MARKED`',
      '`{"requirement":"REQ-n"}`',
      '`QUESTION_ABOUT_SHAPE`',
      '`QUESTION_ABOUT_ON_MERGE_WAIT`',
      '`forge-runner question ask --requirement REQ-n`',
      '`QUESTION_SUBJECT_REQUIRED`',
      '"carriedBy"',
      '`ARTIFACT_CARRIER_SHIPPED`',
      // a release that stopped says what left; a pin-only dependent is re-pinned in one act
      '`carried`',
      '/release-batches/<runId>/carried',
      '`RELEASE_VERSION_UNDECIDED`',
      '/design/repins',
      '`WORKFLOW_REPIN_PENDING_CHANGE`',
      // each finding goes to its place
      '**What you find goes to its place.**',
      'A feature never starts as an issue you filed.',
      '**Inside the fix**: a defect the fix needs, to bound its impact or to prove itself',
      '**Debt for Audit**: a technical defect that stands alone',
      '**An issue of its own**: only where a technical finding needs its own priority',
      'declared under `Extra fixes:`',
      'parked at `needs_info` with that act as the question',
      // another project's part goes through the channel, never to a person (ISS-1279)
      '**A part another project builds goes to it through the ecosystem channel.**',
      'Nor is it handed to a person while a channel links the two.',
      '`"type": "change-request"`',
      'The fence refusal names this act',
      'send that project a change request through the channel',
      // another project's defect goes to its intake, recorded on both items (ISS-1286)
      '`…/channel/handoffs -X POST` files it there as feedback naming your item',
      // the owner's ruling in his room is his word, never a relayed one (ISS-1357, FB-770)
      "one the room records as his linked account's act, or quotes from his own message, is his word",
      'record a decision citing that message, and ask him again only for an irreversible step, real money or a credential',
      // the questions card beneath says the same where a master would ask him
      'that is his word: act on it and record a decision citing his message',
    ]) {
      expect(MASTER).toContain(word);
    }
  });

  it('the dispatch guide carries direct mode and the run declaration the skill restated', () => {
    for (const word of [
      'A project whose gate profile is not `strict`',
      'Take every issue the order admits, and each that arrives mid-batch',
      'one issue is never split across releases',
      'Hand every build part to a general-purpose subagent',
      'no two builders share a tree',
      "Fold each builder's commits into the batch branch (cherry-pick or merge) and remove its tree once it is folded",
      'Declare its run first',
      '`RUN_SLOT_UNAVAILABLE`',
      "Keep this session free to triage, answer a room agent's ask before any other work",
      'build in it only a change too small to brief',
      'the assumption written as one line on the issue or in the commit body',
      'No issue gets its own plan, its own full suite or its own release',
      "{ workState: { step: 'build' } }",
      'Push to the base branch only where the project lands by push',
      'a red there is fixed forward in the next batch',
      'a part that touches shared logic, billing, permissions or data is checked wide early',
      'Where a project rule asks for more before the landing, that rule holds',
      'never fixed inside the batch and never filed as an issue',
      'Release the batch once',
      'once it was checked on the running build',
      'goes into the next batch, never a release of its own',
      'the holder alone moving the issue into',
      'a close only with each unmet criterion moved out on the record',
      '`forge-runner run declare',
      '`forge-runner run brief <run id>`',
      'A part another project builds is handed to it as a change request through the ecosystem channel',
    ]) {
      expect(DISPATCH).toContain(word);
    }
  });
});
