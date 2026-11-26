import { describe, expect, it } from 'vitest';
import { masterWork } from './owed.js';

/** A project with a run slot free: the admissible line asks for a build (ISS-1297). */
const FREE = { held: 1, inUse: 0 };

// @direct-test-of packages/core/src/masters/pass-order.ts

// The owed-work fixture of owed.test.ts, cut to the work a direct-mode pass is composed over.
const none = {
  designs: [],
  designApprovals: [],
  revisions: [],
  breakdowns: [],
  triages: [] as { key: string }[],
  confirms: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [],
  releaseMerges: [],
  releaseApprovals: [],
  releaseActs: [],
  standingActs: [],
  answers: [],
  stewardAsks: [],
  questions: [],
  landedWork: [],
  wedgedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  releaseHolds: [],
  endedRunHolds: [],
  requests: [],
  carriers: [],
  intakeFailures: [],
  reviews: [],
  liveChecks: [],
  contentLanguage: 'en',
};

const issue = (issueId: string) => ({
  issueId,
  issueKey: `ISS-${issueId}`,
  projectId: 'p',
  title: null,
  description: null,
  priority: null,
  category: null,
  status: 'open',
  ageMinutes: 1,
  relations: [],
  mergedAt: null,
  branch: null,
  pullRequests: [],
});

// owner, 2026-10-30: a project that runs fast (fast delivery on, not strict) has its master
// build and record afterwards, so the pass prompt the box types names no dispatch and no brief.
describe('masterWork under direct mode: the pass is told to build, not to dispatch', () => {
  const owed = { ...none, triages: [{ key: 'FB-1' }] };
  const direct = masterWork([issue('a')], owed, 'direct', FREE);
  const dispatch = masterWork([issue('a')], owed, 'dispatch', FREE);

  it('names no dispatch, lands, then records in one go under the kernel, and still carries what is owed', () => {
    expect(direct.nudge.startsWith('Pass.')).toBe(true);
    expect(direct.nudge).not.toContain('dispatch skill');
    // ISS-845 (FB-453): a bare push to the base branch overrides a project that lands only by MR
    expect(direct.nudge).not.toContain('land it on the base branch');
    expect(direct.nudge).not.toContain('its own tests pass');
    expect(direct.nudge).not.toContain('a close by anything but a release');
    expect(direct.nudge).not.toContain('build the batch yourself');
    for (const said of [
      'Dispatch no runner role',
      // ISS-1363 (FB-779, FB-778): the role a builder's run is declared with, and criteria on the record
      "declare each builder's run `--role general-purpose`",
      "write each issue's criteria on its record before its build",
      // ISS-1243 item 22: subagents build, the master's session stays free for agents' asks;
      // ISS-1254: each in a tree of its own, never one tree shared
      'hand every build part of the batch to general-purpose subagents, one worktree each, whose commits you fold into the batch branch',
      "so your own pane stays free for triage, for a room agent's ask (it goes first) and for the landing; only a change too small to brief is built here",
      // ISS-1050: "its own tests" read as the whole suite, which a master ran before every landing
      "Land through the project's own landing route once the batch builds (typecheck included) and the tests related to its changed files pass",
      'the whole suite, lint and CI run after the push, and a red there is fixed forward',
      'A project rule that asks for more before landing still holds',
      'an MR where the project lands by change request',
      'a push to the base branch only where it lands by push',
      '`awaiting_release` without a recorded merge (`forge-runner api issues/<id>/merge -X POST` at the landing sha)',
      'only once you have checked it live, after landing',
      // ISS-1473: the three checks before the mark
      'call each new route once with its intended caller and see it answer',
      'place it on the record (a dated decision, or skipped with its reason) instead of marking over it',
      "read a question's options against the refusals core holds (`JUDGED_ON_PRODUCTION`)",
      'a move off a legal edge or without its reason',
      "anyone but the issue's holder",
      // ISS-1062: the holder closes from awaiting_release once met in scope, so the release no longer owns the close
      'a close by anyone but the holder, from anywhere but `awaiting_release`, or leaving a criterion it did not meet with nowhere to go',
      '1 feedback item owes a triage (FB-1)',
    ]) {
      expect(direct.nudge).toContain(said);
    }
  });

  // ISS-861 (owner, 2026-11-01): a pass is told its goal and the kernel, never asked to account
  // for every row it did not take, nor walked through a per-issue claim-land-mark-move recipe.
  it('asks no why-not report and carries no per-issue recipe, in either mode', () => {
    for (const nudge of [direct.nudge, dispatch.nudge]) {
      expect(nudge).not.toContain('why you did not');
      expect(nudge).not.toContain('did not dispatch the rest');
      expect(nudge).not.toContain('did not take the rest');
    }
    expect(direct.nudge).not.toContain('build each issue you take yourself');
    expect(direct.nudge).not.toContain('record in one go');
    expect(direct.nudge).not.toContain('comment what shipped');
  });

  // ISS-943: the room door is named on every pass, so no master relays a result by hand
  it('names the room door with its body on the nudge, in either mode', () => {
    for (const nudge of [direct.nudge, dispatch.nudge]) {
      expect(nudge).toContain(
        '`forge-runner api projects/<projectId>/support/master-posts -X POST` with `{ text, rid?, thread? }`',
      );
      expect(nudge).toContain('(Telling a room what came of it)');
      // ISS-1466: a users' room is told through its bot, never by the master's own words
      expect(nudge).toContain('support/master-tells -X POST');
      expect(nudge).toContain('you hand its bot the facts');
      expect(nudge).toContain('where no channel agent owns the thread');
    }
  });

  it('briefs a new pane the same, and leaves every other project as it was', () => {
    expect(masterWork([issue('a')], none, 'direct', FREE).owedLine).toContain('works direct');
    expect(masterWork([issue('a')], none, 'dispatch', FREE).owedLine).toBe('');
    expect(
      dispatch.nudge.startsWith('Pass. Run the wave by `forge-runner api guides/dispatch.md`'),
    ).toBe(true);
    expect(dispatch.nudge).not.toContain('works direct');
    const { nudge: _d, owedLine: _dl, ...rest } = direct;
    const { nudge: _n, owedLine: _nl, ...was } = dispatch;
    expect(rest).toEqual(was);
  });
});

// ISS-304 (FB-89's reopen, 2026-10-07): "Hand it to the dispatch skill" resolved to the plugin's
// forge:dispatch on a pane with forge-plugin installed, so dev masters ran plugin verbs for hours.
describe('masterWork names no plugin skill and no plugin verb, in either mode', () => {
  const owed = {
    ...none,
    triages: [{ key: 'FB-1' }],
    designs: [{ workflowId: 'w', flow: 'f', revision: 2 }],
    revisions: [{ key: 'REQ-1', revision: 2 }],
    builderRuns: [{ id: 'b1', ecosystem: 'e' }],
  };
  const plugin = /dispatch skill|issue-flow skill|\bforge:[a-z]|`forge (?!-)[a-z]/;

  for (const mode of ['dispatch', 'direct'] as const) {
    it(`over every owed kind, ${mode}`, () => {
      const { nudge } = masterWork([issue('a')], owed, mode, FREE);
      expect(nudge).not.toMatch(plugin);
      expect(nudge).toContain('`forge-runner api guides/dispatch.md`');
    });
  }
});

// ISS-1243 items 14, 21: a room agent's ask waits with a person behind it, so the pass names it before
// every other owed thing, says each ask's wait, and says a breach past the bound
// @direct-test-of packages/core/src/masters/owed-agent-asks.ts
describe("a room agent's ask comes first in the pass, its wait and breach said", () => {
  const ask = (id: string, minutes: number, breached: boolean) => ({
    id,
    rid: 'room-1',
    thread: 'th-1',
    question: 'Is the size-M print rule live?',
    waitedMs: minutes * 60_000,
    breached,
    boundMinutes: 10,
  });
  const owed = {
    ...none,
    triages: [{ key: 'FB-1' }],
    agentAsks: [ask('a1', 3, false), ask('a2', 14, true)],
  };

  for (const mode of ['dispatch', 'direct'] as const) {
    it(mode, () => {
      const work = masterWork([issue('a')], owed, mode, FREE);
      const first = work.nudge.indexOf('First, before any other work in this pass');
      expect(first).toBeGreaterThan(-1);
      expect(first).toBeLessThan(work.nudge.indexOf('FB-1'));
      expect(work.nudge).toContain(
        'a2 from room room-1 thread th-1, waiting 14 min, past the bound',
      );
      expect(work.nudge).toContain('1 has waited past the 10-minute bound');
      expect(work.nudge).toContain('support/master-asks/<askId>/answer -X POST');
      expect(work.owed).toBe(3);
      // an answered ask leaves the work, so the digest moves and the box nudges again
      expect(masterWork([issue('a')], { ...owed, agentAsks: [] }, mode, FREE).digest).not.toBe(
        work.digest,
      );
    });
  }
});

// ISS-1297 (FB-720): while every run slot was in use, each pass asked a build or a pass-over of every
// row, though each declare was refused RUN_SLOT_UNAVAILABLE; the wait is said once instead
// @direct-test-of packages/core/src/masters/admissible-line.ts
describe('a direct pass with every run slot in use asks no build', () => {
  const rows = ['1', '2', '3', '4', '5', '6'].map(issue);
  const full = masterWork(rows, none, 'direct', { held: 2, inUse: 2 });
  const free = masterWork(rows, none, 'direct', { held: 2, inUse: 1 });

  it('says once how many wait for a run slot, with the first keys, and asks neither act', () => {
    expect(full.nudge).toContain(
      "6 admissible issues wait for a run slot, all 2 of the project's in use: ISS-1, ISS-2, ISS-3, ISS-4, ISS-5, and 1 more after them.",
    );
    expect(full.nudge).toContain('Build none and record no pass-over for them');
    expect(full.nudge).not.toContain('open for you to build');
    expect(full.nudge).not.toContain('why you pass');
    expect(full.owedLine).toContain('wait for a run slot');
  });

  it('with a slot free, names each row to build again, and the digest moves so the pass is asked', () => {
    expect(free.nudge).toContain('6 admissible issues are open for you to build');
    expect(free.nudge).toContain('ISS-1 1; ISS-2 2');
    expect(free.nudge).toContain('record on the issue why you pass one over');
    expect(free.nudge).not.toContain('wait for a run slot');
    expect(free.digest).not.toBe(full.digest);
  });

  it('one row reads in the singular, and a dispatching pass is left as it was', () => {
    expect(masterWork([issue('a')], none, 'direct', { held: 1, inUse: 1 }).nudge).toContain(
      "1 admissible issue waits for a run slot, all 1 of the project's in use: ISS-a. Build none and record no pass-over for it",
    );
    const dispatch = masterWork(rows, none, 'dispatch', { held: 2, inUse: 2 });
    expect(dispatch).toEqual(masterWork(rows, none, 'dispatch', FREE));
  });

  // ISS-1420: a critical or high row is lent one run past the slots at its declare, so it is named to declare
  it('names a critical or high row to declare now, and none while every row is normal', () => {
    const urgent = [{ ...issue('7'), priority: 'critical' }, ...rows];
    expect(masterWork(urgent, none, 'direct', { held: 1, inUse: 1 }).nudge).toContain(
      'Declare ISS-7 now: a critical or high issue is lent one run past the slots while the box has room.',
    );
    expect(full.nudge).not.toContain('is lent one run past the slots');
  });
});
