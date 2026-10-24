// @direct-test-of packages/core/src/masters/owed.ts
// @direct-test-of packages/core/src/assistant/prompt/
// @direct-test-of packages/core/src/assistant/door-persona.ts
// @direct-test-of packages/core/src/guides/guide-ref.ts
import { describe, expect, it } from 'vitest';
import { webConversationPersona } from '../assistant/door-persona.js';
import { composeLayers } from '../assistant/prompt/layer.js';
import { METHOD_LAYERS } from '../assistant/prompt/layers.js';
import { masterWork, owedLine } from '../masters/owed.js';
import { provideAssistantMethod } from './assistant-method-guide.js';
import { type GuideSlug, guideCall } from './guide-ref.js';
import { getGuide, listGuides } from './registry.js';

// REQ-23 BC-2: a prompt Forge composes names the guide that holds a method by its slug, rather than
// restating the guide's text. Restated, the two copies drift apart in silence; named, there is one.

const METHOD = composeLayers(METHOD_LAYERS);
provideAssistantMethod(METHOD);

/** The longest a run of words a prompt shares with a guide may be before it reads as a sentence
 *  lifted from it. Under it sit the phrases any two texts about one tracker share ("the issue's
 *  release note"); at it, a clause the guide wrote. */
const RESTATED_WORDS = 8;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9<>_/.-]+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/[.-]+$/, ''))
    .filter(Boolean);

/** The longest run of consecutive words `text` shares with `body`. */
function longestSharedRun(text: string, body: string): string {
  const a = words(text);
  const b = words(body);
  let best: string[] = [];
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      const run = (prev[j - 1] ?? 0) + 1;
      cur[j] = run;
      if (run > best.length) best = a.slice(i - run, i);
    }
    prev = cur;
  }
  return best.join(' ');
}

/** Each guide the text restates, but `source`, with the run it lifted. */
function restated(text: string, source?: GuideSlug): string[] {
  return listGuides()
    .filter(({ slug }) => slug !== source)
    .map(({ slug }) => ({ slug, run: longestSharedRun(text, getGuide(slug)?.body ?? '') }))
    .filter(({ run }) => words(run).length >= RESTATED_WORDS)
    .map(({ slug, run }) => `${slug}: "${run}"`);
}

const none = {
  designs: [],
  revisions: [],
  breakdowns: [],
  triages: [],
  comments: [],
  documents: [],
  builderRuns: [],
  releaseNotes: [],
  warnedNotes: [],
  unnamedReleases: [] as { version: string }[],
  releaseMerges: [] as Parameters<typeof owedLine>[0]['releaseMerges'],
  releaseApprovals: [] as Parameters<typeof owedLine>[0]['releaseApprovals'],
  answers: [],
  stewardAsks: [] as Parameters<typeof owedLine>[0]['stewardAsks'],
  landedWork: [] as Parameters<typeof owedLine>[0]['landedWork'],
  contentLanguage: 'vi',
};

/** One item of each kind a master is owed, and the guide that holds its method. */
const OWED_KINDS = {
  designs: {
    item: { workflowId: 'w1', flow: 'catalog-context', revision: 1 },
    guide: 'workflow-design',
  },
  revisions: { item: { key: 'REQ-2', revision: 2 }, guide: 'requirement-lifecycle' },
  breakdowns: { item: { key: 'REQ-3', overdue: true }, guide: 'suggestions' },
  triages: { item: { key: 'FB-2' }, guide: 'feedback-triage' },
  comments: { item: { issueKey: 'ISS-7', commentId: 'c1' }, guide: 'ecosystem-inbox' },
  documents: { item: { id: 'd1', number: '12' }, guide: 'ecosystem-inbox' },
  builderRuns: { item: { id: 'b1', ecosystem: 'e' }, guide: 'ecosystem-inbox' },
  releaseNotes: { item: { issueId: 'u6', key: 'ISS-6' }, guide: 'issue-flow' },
  warnedNotes: {
    item: { issueId: 'u7', key: 'ISS-7', problems: ['not in Vietnamese'] },
    guide: 'issue-flow',
  },
  landedWork: {
    item: { issueId: 'u8', key: 'ISS-8', commit: null, mergedAt: '2026-10-24T20:00:00.000Z' },
    guide: 'issue-flow',
  },
} as const satisfies Record<string, { item: object; guide: GuideSlug }>;

const everyOwed = {
  ...none,
  ...Object.fromEntries(Object.entries(OWED_KINDS).map(([kind, { item }]) => [kind, [item]])),
  unnamedReleases: [{ version: '0.1.0' }],
  releaseMerges: [
    {
      runId: 'r1',
      version: '0.1.0',
      next: { label: '!5008', number: 5008, issueId: 'u1', issueKey: 'ISS-1' },
      merged: 0,
      total: 2,
    },
  ],
  releaseApprovals: [{ runId: 'r2', version: '0.2.0' }],
  answers: [{ issueKey: 'ISS-9', questionId: 'q1', outcome: null }],
} as typeof none;

describe('the master nudge names a guide by slug, never restates one', () => {
  it('restates no guide, with every kind of owed work on it', () => {
    expect(restated(masterWork([], everyOwed).nudge)).toEqual([]);
  });

  it.each(Object.entries(OWED_KINDS))(
    'names the guide that holds the method for %s',
    (kind, { item, guide }) => {
      expect(owedLine({ ...none, [kind]: [item] })).toContain(`\`${guideCall(guide)}\``);
    },
  );
});

describe('the chat system prompt is the source of its method guide, and restates no other', () => {
  const prompt = webConversationPersona('Demo', 'demo', 'a person');

  it('carries answering-as-the-assistant as the very text the guide is rendered from', () => {
    expect(getGuide('answering-as-the-assistant')?.body).toBe(METHOD);
    expect(prompt).toContain(METHOD);
  });

  it('restates no other guide', () => {
    expect(restated(prompt, 'answering-as-the-assistant')).toEqual([]);
  });
});

describe('the measure', () => {
  it('goes red on a sentence lifted from a guide', () => {
    const lifted = 'and each step an admin must take before it goes out in adminSteps';
    expect(restated(`Write the note, ${lifted}.`)).toEqual([
      `issue-flow: "${words(lifted).join(' ')}"`,
    ]);
    expect(restated('Write the note as the issue-flow guide says.')).toEqual([]);
  });
});
