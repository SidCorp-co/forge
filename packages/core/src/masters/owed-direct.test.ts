import { describe, expect, it } from 'vitest';
import { masterWork } from './owed.js';

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
  answers: [],
  stewardAsks: [],
  landedWork: [],
  marks: [],
  filings: [],
  recordings: [],
  requests: [],
  carriers: [],
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

// owner, 2026-10-30: a project that runs fast (gate profile yolo, fast delivery on) has its master
// build and record afterwards, so the pass prompt the box types names no dispatch and no brief.
describe('masterWork under direct mode: the pass is told to build, not to dispatch', () => {
  const owed = { ...none, triages: [{ key: 'FB-1' }] };
  const direct = masterWork([issue('a')], owed, 'direct');
  const dispatch = masterWork([issue('a')], owed, 'dispatch');

  it('names no dispatch, lands, then records in one go under the kernel, and still carries what is owed', () => {
    expect(direct.nudge.startsWith('Pass.')).toBe(true);
    expect(direct.nudge).not.toContain('dispatch skill');
    for (const said of [
      'Dispatch no runner role',
      'general-purpose subagent',
      'land it on the base branch once it builds and its own tests pass',
      'mark it merged at the landing sha',
      'move it to `awaiting_release`',
      'comment what shipped',
      'only once you have checked it live, after landing',
      'a legal edge or without its reason',
      '`awaiting_release` without a recorded merge',
      "anyone but the issue's holder",
      'a close by anything but a release',
      '1 feedback item owes a triage (FB-1)',
    ]) {
      expect(direct.nudge).toContain(said);
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
