// @direct-test-of packages/core/src/support/promise.ts
// @direct-test-of packages/core/src/support/kept-answers.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import allowlist from './speech-allowlist.json' with { type: 'json' };

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url));
const EXTRA_FILES = ['mcp/scenarios-room.ts', 'mcp/scenarios-support.ts'];
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

// ISS-1475 fix-forward 5: the class by construction. EVERY string literal under support/ (and the room
// scenarios) that tells a person, room or owner something is matched by verb and object; a literal that
// matches must be on the allowlist below, by file and a stable substring, with why it is allowed: it
// reports an OUTCOME (the act completed), a refusal's next step, or information the person owes. A
// text that speaks BEFORE the result exists (a holding line, a promise to report, "noted", "with the
// team") is never allowed: it is rewritten to react with support.react and speak once when the result is in.
const SPEAKS_AT_THE_ACT =
  /(tell|say|post|answer|let) (the room|the person|the asker|the thread|him|them|that thread|this thread|the owner)|is noted|with the team|passed on|passed to|handed|waits on a setup/i;

const ALLOWED_TO_SPEAK: ReadonlyArray<readonly [file: string, text: string, why: string]> = (
  allowlist as ReadonlyArray<{ file: string; text: string; why: string }>
).map((e) => [e.file, e.text, e.why] as const);

const literalListOf = (file: string): string[] => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
};

/** Each literal that speaks to a person at an act and is not on the allowlist, as `file: "text"`. */
function unlistedSpeech(files: Record<string, string[]>): string[] {
  return Object.entries(files).flatMap(([file, texts]) =>
    texts
      .filter((t) => SPEAKS_AT_THE_ACT.test(t))
      .filter((t) => !ALLOWED_TO_SPEAK.some(([f, sub]) => f === file && t.includes(sub)))
      .map((t) => `${file}: "${t.slice(0, 160)}"`),
  );
}

const speechFiles = (): Record<string, string[]> =>
  Object.fromEntries(
    [
      ...sourceFiles(SUPPORT_DIR),
      ...EXTRA_FILES.map((f) => fileURLToPath(new URL(`../${f}`, import.meta.url))),
    ].map((f) => [relative(join(SUPPORT_DIR, '..'), f), literalListOf(f)]),
  );

describe('no text under support/ speaks to a person before its result exists (ISS-1475)', () => {
  it('fails, naming file and text, on a new speaking text that is not allowed', () => {
    expect(
      unlistedSpeech({
        'support/promise.ts': [
          'Nothing was promised: tell the person their report is with the team',
        ],
        'support/kept-answers.ts': [
          'You may tell the room his answer is noted and waits on a setup step',
        ],
        'support/fine.ts': ['react with support.react and post ONE message when done'],
      }),
    ).toEqual([
      'support/promise.ts: "Nothing was promised: tell the person their report is with the team"',
      'support/kept-answers.ts: "You may tell the room his answer is noted and waits on a setup step"',
    ]);
  });

  it('holds for every string literal under support/ and the room scenarios', () => {
    expect(unlistedSpeech(speechFiles())).toEqual([]);
  });

  it('gives each allowlist entry a reason and a live substring', () => {
    const files = speechFiles();
    for (const [file, text, why] of ALLOWED_TO_SPEAK) {
      expect(why.length, `${file} "${text}"`).toBeGreaterThan(10);
      expect(
        (files[file] ?? []).some((t) => t.includes(text) && SPEAKS_AT_THE_ACT.test(t)),
        `stale allowlist entry ${file} "${text}"`,
      ).toBe(true);
    }
  });
});
