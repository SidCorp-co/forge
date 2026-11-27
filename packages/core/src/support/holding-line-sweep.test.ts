// @direct-test-of packages/core/src/support/ops-prompt.ts
// @direct-test-of packages/core/src/support/room-cards.ts
// @direct-test-of packages/core/src/support/master-ask.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { servedGuideBody } from '../guides/index.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { actCard, SUPPORT_ACT_CARDS } from './act-cards.js';
import { operationsBrief } from './ops-prompt.js';
import { supportBrief } from './prompt.js';

// ISS-1475 (owner 2026-11-26): a thread is never told "it is in hand". A reaction acknowledges and ONE
// message follows when done. The judges of dev.843 and dev.844 failed it because texts still taught the
// holding line, then taught its TIMING: a message at the moment of raising, when the raise only returns
// where it landed. This guards the class, "a message at the raise instead of when the answer is in":
// the three holding phrases and the timing phrases found by meaning, over every text an agent reads.
const HOLDING = [
  /in hand\b/i,
  /done or in hand/i,
  /one short line that it/i,
  /(result|act) says where it landed/i,
  /where its result says/i,
  /named where its result/i,
  /tell (that|the|this) thread the answer, or/i,
  /once (it|the act|the raise) (is|was) raised/i,
  /after you raise/i,
  /eyes\)/i,
  // the class by meaning (ISS-1475 fix-forward 4): an instruction to tell a person, at the act, that
  // something is recorded, raised, promised, handed, being looked at or not yet known. A message
  // asking the person for a decision or information is the one allowed kind and is not matched.
  /tell (them|the person|the asker|that thread|the thread)[^.]{0,60}(is recorded|will let them know|not seen|was raised|handed)/i,
  /you will let them know/i,
  /post nothing more before then/i,
  /have not seen (it|the screen) yet/i,
  /and tell them so/i,
  /\bsay\b[^.]{0,40}(it is recorded|you are looking|you are checking)/i,
];

/** The name of each text that teaches a holding line, with the phrase it holds. */
function holdingLines(texts: Record<string, string>): string[] {
  return Object.entries(texts).flatMap(([name, body]) =>
    HOLDING.filter((re) => taught(re, body)).map((re) => `${name}: ${re}`),
  );
}

/** A phrase counts only where its own sentence does not forbid it ("never tell the asker it was handed"). */
function taught(re: RegExp, body: string): boolean {
  const g = new RegExp(re.source, 'gi');
  for (const m of body.matchAll(g)) {
    const before = body.slice(0, m.index);
    const sentence = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1);
    if (!/\b(never|not|no|nor|without|instead of|in place of)\b|\bnothing\b/i.test(sentence)) {
      return true;
    }
  }
  return false;
}

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });

const role = { name: 'ops', persona: 'You are ops.', grants: ['read'] } as unknown as Parameters<
  typeof operationsBrief
>[0]['role'];

// EVERY string literal of every non-test .ts file under support/ (read from disk; comments are not
// literals) plus the room scenarios, one text per file. The sweep reads the whole directory, never a list.
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
const literalsOf = (file: string): string => {
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
  return out.join('\n');
};
const supportLiterals = (): Record<string, string> =>
  Object.fromEntries(
    [
      ...sourceFiles(SUPPORT_DIR),
      ...EXTRA_FILES.map((f) => fileURLToPath(new URL(`../${f}`, import.meta.url))),
    ].map((f) => [`the string literals of ${relative(join(SUPPORT_DIR, '..'), f)}`, literalsOf(f)]),
  );

const served = (): Record<string, string> => ({
  'the room agent guide': servedGuideBody(ROOM_AGENT_GUIDE),
  'the room brief': supportBrief({ projectName: 'P', product: null, tools: [] }),
  'the operations brief': operationsBrief({ role, scope: 'org', reach: [] }),
  ...Object.fromEntries(
    Object.entries(SUPPORT_ACT_CARDS).map(([act, card]) => [
      `the card of support.${act}`,
      JSON.stringify(card),
    ]),
  ),
  ...supportLiterals(),
});

describe('no served text teaches a holding line (ISS-1475)', () => {
  it('fails, naming the text, on a card that still says it is in hand', () => {
    expect(
      holdingLines({
        'the card of support.route': 'tell the thread it is in hand',
        'the operations brief': 'the thread hears one short line that it is in hand',
        fine: 'react with support.react and post ONE message when done',
      }),
    ).toEqual([
      'the card of support.route: /in hand\\b/i',
      'the operations brief: /in hand\\b/i',
      'the operations brief: /one short line that it/i',
    ]);
  });

  it('fails, naming the text, on a raise told at the moment it lands', () => {
    expect(
      holdingLines({
        'the card of support.technical':
          'tell that thread the answer, or where its result says it landed',
        'the operations brief':
          "the thread hears ONE message once the act's result says where it landed",
        fine: 'tell that thread once, when the answer is in',
      }),
    ).toEqual([
      'the card of support.technical: /where its result says/i',
      'the card of support.technical: /tell (that|the|this) thread the answer, or/i',
      'the operations brief: /(result|act) says where it landed/i',
    ]);
  });

  it('fails, naming the text, on the recorded, promised and not-yet-seen lines of fix-forward 4', () => {
    expect(
      holdingLines({
        'the string literals of support/fixes.ts':
          'tell the person it is recorded, in your words, and post nothing more before then',
        'the string literals of support/promise.ts':
          'Tell Ann that you will let them know here when it reaches staging',
        'the card of support.look': 'say in plain words you have not seen the screen yet',
        'the card of support.promise': 'support.promise { thread } and tell them so',
        fine: 'react with support.react; where you cannot look, say so once with what you need from the person',
      }).map((l) => l.split(':')[0]),
    ).toEqual([
      'the string literals of support/fixes.ts',
      'the string literals of support/fixes.ts',
      'the string literals of support/promise.ts',
      'the card of support.look',
      'the card of support.promise',
    ]);
  });

  it('reads every non-test file under support/', () => {
    const names = Object.keys(supportLiterals());
    expect(names).toContain('the string literals of support/fixes.ts');
    expect(names).toContain('the string literals of support/promise.ts');
    expect(names.some((n) => n.endsWith('.test.ts'))).toBe(false);
  });

  it('holds for the guide, the briefs, every act card and every string literal under support/', () => {
    expect(holdingLines(served())).toEqual([]);
  });

  it('teaches a reaction and one message in the ask_master and route cards', () => {
    expect(actCard('ask_master').situations[0]?.do).toContain(
      'react with support.react, then post ONE message when done',
    );
    expect(JSON.stringify(actCard('route'))).toContain(
      'react to the asker’s message with support.react and post ONE message when the answer is in',
    );
  });
});
