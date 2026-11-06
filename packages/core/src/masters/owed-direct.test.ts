import { describe, expect, it } from 'vitest';
import { masterWork } from './owed.js';

// @direct-test-of packages/core/src/masters/pass-order.ts

// The owed-work fixture of owed.test.ts, cut to the work a direct-mode pass is composed over.
const none = {
  designs: [],
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
  answers: [],
  stewardAsks: [],
  questions: [],
  landedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  releaseHolds: [],
  endedRunHolds: [],
  requests: [],
  carriers: [],
  reviews: [],
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
  const direct = masterWork([issue('a')], owed, 'direct');
  const dispatch = masterWork([issue('a')], owed, 'dispatch');

  it('names no dispatch, lands, then records in one go under the kernel, and still carries what is owed', () => {
    expect(direct.nudge.startsWith('Pass.')).toBe(true);
    expect(direct.nudge).not.toContain('dispatch skill');
    // ISS-845 (FB-453): a bare push to the base branch overrides a project that lands only by MR
    expect(direct.nudge).not.toContain('land it on the base branch');
    expect(direct.nudge).not.toContain('its own tests pass');
    for (const said of [
      'Dispatch no runner role',
      'general-purpose subagents on disjoint files',
      'build the batch yourself',
      // ISS-1050: "its own tests" read as the whole suite, which a master ran before every landing
      "Land through the project's own landing route once the batch builds (typecheck included) and the tests related to its changed files pass",
      'the whole suite, lint and CI run after the push, and a red there is fixed forward',
      'A project rule that asks for more before landing still holds',
      'an MR where the project lands by change request',
      'a push to the base branch only where it lands by push',
      '`awaiting_release` without a recorded merge (`forge-runner api issues/<id>/merge -X POST` at the landing sha)',
      'only once you have checked it live, after landing',
      'a move off a legal edge or without its reason',
      "anyone but the issue's holder",
      'a close by anything but a release',
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
    }
  });

  it('briefs a new pane the same, and leaves every other project as it was', () => {
    expect(masterWork([issue('a')], none, 'direct').owedLine).toContain('works direct');
    expect(masterWork([issue('a')], none, 'dispatch').owedLine).toBe('');
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
      const { nudge } = masterWork([issue('a')], owed, mode);
      expect(nudge).not.toMatch(plugin);
      expect(nudge).toContain('`forge-runner api guides/dispatch.md`');
    });
  }
});
