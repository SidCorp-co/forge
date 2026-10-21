// @direct-test-of scripts/check-copy-budget.mjs
// @direct-test-of .forge/conformance.json
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  faults,
  fieldSentencesOf,
  inlineCopyOf,
  inlineFaults,
  keyEndsWith,
  keyHasSegment,
  kindOf,
  overBudget,
  sentencesOf,
  wordsOf,
} from './copy-budget.mjs';

const CFG = {
  budget: 12,
  refusalBudget: 20,
  emptyBudget: 2,
  refusalSegments: /^(refusal|\w*Refused|deleteMessage)$/,
  emptySegments: /^(empty|empty[A-Z]\w*|none|no[A-Z]\w*)$/,
  explainSegments: /^(hint|\w*Hint|intro|\w*Effect|emptyMessage)$/,
};
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const entry = (key, text, file = 'a/copy.json') => ({ file, key, text });
const refusedKeys = (...e) => [...overBudget(e, CFG).keys()].sort();

describe('wordsOf', () => {
  it('counts each placeholder as one word, however it expands', () => {
    expect(wordsOf('Moved {count} issues to {status}')).toBe(5);
    expect(wordsOf('{{current}} / {{total}}')).toBe(3);
  });
  it('is not fooled by runs of whitespace or a blank string', () => {
    expect(wordsOf('  a   b\n c ')).toBe(3);
    expect(wordsOf('')).toBe(0);
  });
});

describe('kindOf', () => {
  const kind = (key, text = 'Runs') => kindOf(key, text, CFG).kind;
  it('reads an explanation and an empty state from the last segment only', () => {
    expect(kind('x.views.hint')).toBe('explain');
    expect(kind('x.hint.title')).toBe('copy');
    expect(kind('x.list.none')).toBe('empty');
    expect(kind('x.none.title')).toBe('copy');
  });
  it('reads a refusal from any segment, whole', () => {
    expect(kind('x.refusal.moved')).toBe('refusal');
    expect(keyHasSegment('x.refusals.list', CFG.refusalSegments)).toBe(false);
    expect(keyEndsWith('x.emptyHint', CFG.explainSegments)).toBe(true);
  });
  it('lets an explanation win, so an empty state that explains is refused, not budgeted', () => {
    expect(kind('x.emptyMessage')).toBe('explain');
    expect(kind('x.refusal.hint')).toBe('explain');
  });
});

// The shapes and the empty lead the repository declares, read from .forge/conformance.json, so a
// pattern weakened there turns these red rather than a copy of it kept here.
const DECLARED = JSON.parse(
  readFileSync(new URL('../../.forge/conformance.json', import.meta.url), 'utf8'),
).checkers['copy-budget'];
const LIVE = {
  ...CFG,
  refusalSegments: new RegExp(DECLARED.refusalSegments),
  emptySegments: new RegExp(DECLARED.emptySegments),
  explainSegments: new RegExp(DECLARED.explainSegments),
  emptyLead: new RegExp(DECLARED.emptyLead),
  explainShapes: DECLARED.explainShapes.map(({ name, pattern }) => ({
    name,
    pattern: new RegExp(pattern),
  })),
};
const liveRefused = (...e) => [...overBudget(e, LIVE).values()].map((o) => `${o.key}:${o.kind}`);

describe('kindOf by text — a sentence explains whatever key it sits under (REQ-43 BC-4, BC-6)', () => {
  // Each string a release judge read on forge-dev 0.4.0-dev.268, under the key it was served from:
  // on 840ffd104 the gate read all of them as plain copy and passed them.
  const served = [
    [
      'settings.project.testing.summary',
      'Who a run signs in as, per environment. Values are never shown.',
    ],
    [
      'settings.project.raw.documentsSummary',
      'What every tab reads its fields from. Edit with care.',
    ],
    ['settings.project.env.liveOutside', 'Not tracked: it goes live outside Forge'],
    ['feedback.progress.state.drafted', 'Not started: its issues are drafts'],
    ['runners.master.toStop', 'To stop one, run'],
  ];
  it('refuses each explaining line the judge saw, as an explanation', () => {
    expect(liveRefused(...served.map(([k, t]) => entry(k, t)))).toEqual(
      served.map(([k]) => `${k}:explain`),
    );
  });
  it('holds each empty state the judge saw to two words', () => {
    expect(
      liveRefused(
        entry('releases.bannerNothingOwed', 'Nothing is owed on it.'),
        entry('settings.project.testing.usedNowhere', 'No environment uses it'),
      ),
    ).toEqual(['releases.bannerNothingOwed:empty', 'settings.project.testing.usedNowhere:empty']);
  });
  it('refuses the same sentence under a plain key as under an explaining one', () => {
    const line = 'Who a run signs in as, per environment. Values are never shown.';
    expect(liveRefused(entry('x.summaryHint', line), entry('x.summary', line))).toEqual([
      'x.summaryHint:explain',
      'x.summary:explain',
    ]);
  });
  it('lets a state through: a value after a colon, one sentence, a CODE, an abbreviation, a short empty', () => {
    expect(
      liveRefused(
        entry('a.running', 'Running: {n} of {total} issues in progress'),
        entry('a.checks', 'Checks: {passed} met, {open} open'),
        entry('a.merged', 'Merged into {into} as {sha}.'),
        entry('a.placeholder', 'e.g. CI deploy token'),
        entry('a.notJudged', 'Not judged yet'),
        entry('a.rule', 'CONTRACT_WAIT_UNSETTLED: waits on a contract version not yet approved'),
        entry('a.nothing', 'Nothing'),
        entry('a.runs', 'No runs'),
        entry('a.choose', 'Why it goes back'),
      ),
    ).toEqual([]);
  });
  it('keeps a refusal its second sentence, since it says what was wrong and then what to do', () => {
    expect(
      liveRefused(entry('x.refusal.access', 'No access to this project. Ask an admin.')),
    ).toEqual([]);
  });
  it('names the shape an explanation took and what to do', () => {
    expect(
      faults(
        overBudget(
          [
            entry(
              'releases.trainNonePlanned',
              'No release planned. Issues queue at Awaiting release.',
            ),
          ],
          LIVE,
        ),
      ),
    ).toEqual([
      'a/copy.json · releases.trainNonePlanned: "No release planned. Issues queue at Awaiting release." explains (a second sentence); keep the state, delete the explanation',
    ]);
  });
});

describe('overBudget', () => {
  it('passes 12 words and refuses 13', () => {
    const over = overBudget([entry('a.ok', words(12)), entry('a.long', words(13))], CFG);
    expect([...over.keys()]).toEqual(['a/copy.json::a.long']);
    expect(over.get('a/copy.json::a.long')).toMatchObject({
      kind: 'copy',
      words: 13,
      budget: 12,
    });
  });
  it('allows a refusal or confirmation 20 and no more, by its key path', () => {
    expect(
      refusedKeys(
        entry('x.refusal.moved', words(20)),
        entry('x.parkRefused', words(21)),
        entry('x.deleteMessage', words(20)),
        entry('x.label', words(20)),
      ),
    ).toEqual(['a/copy.json::x.label', 'a/copy.json::x.parkRefused']);
  });
  it('holds an empty state to two words', () => {
    expect(
      refusedKeys(
        entry('x.empty', 'No runs'),
        entry('x.noMatch', 'No issues match'),
        entry('x.none', 'None'),
      ),
    ).toEqual(['a/copy.json::x.noMatch']);
  });
  it('refuses an explaining string at any length, and a blank one at none', () => {
    expect(
      refusedKeys(
        entry('x.views.hint', 'Short'),
        entry('x.intro', words(30)),
        entry('x.blankHint', ''),
      ),
    ).toEqual(['a/copy.json::x.intro', 'a/copy.json::x.views.hint']);
  });
  it('refuses a line saying what a setting does, however short', () => {
    expect(refusedKeys(entry('x.nameEffect', 'Shown everywhere'))).toEqual([
      'a/copy.json::x.nameEffect',
    ]);
  });
});

describe('faults', () => {
  const linesOf = (...e) => faults(overBudget(e, CFG));
  it('is silent when every string holds its budget', () => {
    expect(linesOf(entry('k', words(12)), entry('k.empty', 'Nothing'))).toEqual([]);
  });
  it('names file, key, count and budget for a long string', () => {
    const [f] = linesOf(entry('k.new', words(13), 'f/copy.json'));
    expect(f).toBe('f/copy.json · k.new: 13 words, budget 12 for a copy string');
  });
  it('names the empty-state budget for a long empty state', () => {
    expect(linesOf(entry('k.none', 'No runs yet'))[0]).toContain(
      '3 words, budget 2 for an empty state',
    );
  });
  it('tells an explaining string to go, not to shrink', () => {
    expect(linesOf(entry('k.hint', 'Who can read this'))[0]).toContain(
      'refused at any length; delete it, or change the control',
    );
  });
  it('lists refusals sorted by file and key, so a run reads the same order twice', () => {
    const lines = linesOf(
      entry('b', words(13), 'z/copy.json'),
      entry('a', words(13), 'a/copy.json'),
    );
    expect(lines.map((l) => l.split(' · ')[0])).toEqual(['a/copy.json', 'z/copy.json']);
  });
});

describe('sentencesOf — the sentences core writes for pages (REQ-43 BC-11)', () => {
  const FILE = 'packages/contracts/src/said-keys.ts';
  const registry = (body) =>
    `import type { SaidEntry } from "./said.js";\n\nexport const SAID = {\n${body}\n} as const satisfies Record<string, SaidEntry>;\n`;

  it('reads each English template of the registry, keyed as core says it', () => {
    const read = sentencesOf(
      registry(
        '\t"runs.holder.queued": { en: "no holder yet: the run is queued" },\n\t"standing.who.named": { en: "{name}", vars: { name: "name" } },',
      ),
      FILE,
      'SAID',
    );
    expect(read).toEqual([
      {
        file: FILE,
        key: 'runs.holder.queued',
        text: 'no holder yet: the run is queued',
      },
      { file: FILE, key: 'standing.who.named', text: '{name}' },
    ]);
  });

  it('refuses a planted over-budget sentence and an explaining one by file and key', () => {
    const read = sentencesOf(
      registry(
        `\t"runs.rule.long": { en: "${words(13)}" },\n\t"masters.refusal.slots": { en: "${words(20)}" },\n\t"integrations.health.autoflow.mintHint": { en: "sign in" },`,
      ),
      FILE,
      'SAID',
    );
    expect(faults(overBudget(read, CFG))).toEqual([
      `${FILE} · integrations.health.autoflow.mintHint: a string that explains a section, a button or who can see something is refused at any length; delete it, or change the control`,
      `${FILE} · runs.rule.long: 13 words, budget 12 for a copy string`,
    ]);
  });

  it('refuses by name a registry it cannot read whole, since a skipped sentence is never held', () => {
    expect(() => sentencesOf(registry('\t"a.b": { en: `${x}` },'), FILE, 'SAID')).toThrow(
      /a\.b: its `en` must be a string literal/,
    );
    expect(() => sentencesOf(registry('\t"a.b": shared,'), FILE, 'SAID')).toThrow(
      /a\.b: an entry of SAID must be/,
    );
    expect(() => sentencesOf(registry(''), FILE, 'OTHER')).toThrow(/declares no `const OTHER/);
    expect(() => sentencesOf(registry(''), FILE, 'SAID')).toThrow(/declares no sentence/);
  });
});

describe('fieldSentencesOf — sentences held as fields of records (REQ-43 BC-11)', () => {
  const FILE = 'packages/contracts/src/checklist-registry.ts';
  const FIELDS = new RegExp(DECLARED.sentences.find((r) => r.file === FILE).fields);
  const checklist = (question) =>
    `export const C = defineChecklist({\n\tid: "feedback_triage",\n\ttitle: "Feedback triage",\n\tquestions: [\n\t\t${question},\n\t],\n});\n`;

  it('reads each sentence a record holds, keyed by the ids around it', () => {
    const read = fieldSentencesOf(
      checklist(
        '{ id: "kind", prompt: "What kind is it?", fix: `Answer "${NONE}".`, answer: { kind: "text" } }',
      ),
      FILE,
      FIELDS,
    );
    expect(read).toEqual([
      { file: FILE, key: 'feedback_triage.title', text: 'Feedback triage' },
      {
        file: FILE,
        key: 'feedback_triage.kind.prompt',
        text: 'What kind is it?',
      },
      { file: FILE, key: 'feedback_triage.kind.fix', text: 'Answer "{x}".' },
    ]);
  });
  it('refuses a planted 40-word fix by its record, which the gate read as nothing on 840ffd104', () => {
    const read = fieldSentencesOf(
      checklist(`{ id: "kind", prompt: "What kind is it?", fix: "${words(40)}" }`),
      FILE,
      FIELDS,
    );
    expect(faults(overBudget(read, LIVE))).toEqual([
      `${FILE} · feedback_triage.kind.fix: 40 words, budget 12 for a copy string`,
    ]);
  });
  it('leaves a label named from another declaration, and refuses one it cannot read', () => {
    expect(
      fieldSentencesOf(
        checklist('{ id: "k", label: LABELS[value], prompt: "Which?" }'),
        FILE,
        FIELDS,
      ),
    ).toEqual([
      { file: FILE, key: 'feedback_triage.title', text: 'Feedback triage' },
      { file: FILE, key: 'feedback_triage.k.prompt', text: 'Which?' },
    ]);
    expect(() =>
      fieldSentencesOf(checklist('{ id: "k", fix: "Pick " + one }'), FILE, FIELDS),
    ).toThrow(/feedback_triage\.k\.fix: a `fix` must be a string written here/);
    expect(() => fieldSentencesOf('export const C = {};', FILE, FIELDS)).toThrow(
      /the scan read nothing/,
    );
  });
});

describe('inlineCopyOf — copy a component writes inline (REQ-43 BC-1, BC-2)', () => {
  const FILE = 'packages/web-v2/src/features/a/b.tsx';
  const ATTRS = /^(title|label|placeholder|aria-label|\w+Label)$/;
  const read = (source) => inlineCopyOf(source, FILE, ATTRS).map((w) => [w.line, w.where, w.text]);

  it('reads JSX text between tags, whitespace folded, at the line its words start', () => {
    expect(read('export const A = () => (\n  <p>\n    Why   we ask\n  </p>\n);')).toEqual([
      [3, 'text', 'Why we ask'],
    ]);
  });
  it('reads a copy attribute, and leaves an attribute that is not copy', () => {
    expect(
      read(
        'const A = () => <input placeholder="Your answer" type="text" className="flex gap" confirmLabel="Reap job" />;',
      ),
    ).toEqual([
      [1, 'placeholder', 'Your answer'],
      [1, 'confirmLabel', 'Reap job'],
    ]);
  });
  it('reads a literal a JSX expression renders: the || fallback, both arms of ?:, and &&', () => {
    expect(
      read(
        'const A = ({ r, x }) => <Page title={r || "Document"}>{x ? "Collapse" : "Expand"}{x && "Shown"}</Page>;',
      ),
    ).toEqual([
      [1, 'title', 'Document'],
      [1, 'text', 'Collapse'],
      [1, 'text', 'Expand'],
      [1, 'text', 'Shown'],
    ]);
  });
  it('leaves a literal passed to a call, since t("…") and cn("…") are arguments, not copy', () => {
    expect(
      read(
        'const A = ({ t }) => <p title={t("issues.title")}>{t("issues.open")}{cn("text sm")}</p>;',
      ),
    ).toEqual([]);
  });
  it('leaves data and punctuation: a URL, an address, a key, a format, an entity, a dot', () => {
    expect(
      read(
        'const A = () => <div><input placeholder="https://chat.example.com" /><input placeholder="you@studio.com" /><input placeholder="sat_…" /><code>is:stuck</code><span>&times;</span>{" · "}<b>x</b></div>;',
      ),
    ).toEqual([]);
  });
  it('reads a copy-named object property in a .ts table a component renders later, not a key it names', () => {
    const TS = 'packages/web-v2/src/features/a/nav-model.ts';
    const found = inlineCopyOf(
      'export const NAV = [\n  { id: "runs", label: "Runs", href: "/runs" },\n  { id: "x", label: "nav.x", title: "hintIssueStatus" },\n];',
      TS,
      ATTRS,
    );
    expect(found.map((w) => [w.line, w.where, w.text])).toEqual([[2, 'label:', 'Runs']]);
    expect(inlineFaults(found)[0]).toContain('property label: "Runs"');
  });
  it('names each by file and line, and says to move or delete it', () => {
    expect(inlineFaults(inlineCopyOf('const A = () => <p>Skip for now</p>;', FILE, ATTRS))).toEqual(
      [
        `${FILE}:1 · JSX text "Skip for now": copy written inline; move it to its feature's copy file, or delete it`,
      ],
    );
  });
});
