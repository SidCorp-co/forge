// Two words the store and the team use that a person reads otherwise. "Binding" is the store's
// word for a project's use of a connection; the Integrations tab says connection or deploy target
// (ISS-1421 r36, judge-145). "Ship" is the team's word for a release, and a person outside the team
// reads "a ship nobody wrote anything about" as a boat (ISS-1421 r39, the master's ruling on
// judge-160). Every sentence core's person-facing code sends is held to both here.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

/** The code whose sentences reach a person: integrations, the merge mark and its landing, the
 *  release, and the door that answers a device pushing through a GitHub connection. An
 *  `*-reference.ts` file is the API reference, whose resource is named by its route
 *  (`/integrations/:bindingId`), and a fixture is a planted input; neither is a sentence sent. */
const SURFACES: ReadonlyArray<{ dir: string; file?: RegExp }> = [
  { dir: 'integrations' },
  { dir: 'release-batch' },
  { dir: 'pipeline', file: /^release-/ },
  { dir: 'issues', file: /^(merge|merged-at|commit-landing|landing-|stated-landing|mark-|releas)/ },
  { dir: 'projects', file: /^(live-source|repository-access|environments)\.ts$/ },
  { dir: 'git', file: /^github-app-credential\.ts$/ },
  { dir: 'schedules', file: /^routes\.ts$/ },
  { dir: 'pipeline', file: /^pipeline-config-schema\.ts$/ },
  { dir: 'assistant/identity', file: /^directory\.ts$/ },
];

/** Where else a release, a merge mark or a close is said to a person: a chain emptied under waiting
 *  work, a dropped blocker's comment, a stranded issue's notice and the stuck words. */
const RELEASE_SURFACES: ReadonlyArray<{ dir: string; file?: RegExp }> = [
  ...SURFACES,
  { dir: 'projects', file: /^(stranded-work|release-chain)\.ts$/ },
  { dir: 'issues', file: /^drop-unblock\.ts$/ },
  { dir: 'pipeline', file: /^stranded-issues\.ts$/ },
  { dir: '../../contracts/src', file: /^stuck-words\.ts$/ },
];

const BINDING = /\b(bindings?|bound|bind|binds|unbind)\b/i;
const SHIP = /\bship(s|ped|ping)?\b/i;

/** A value a caller sends, marked as code: `ship-unverified` names the decision, not the act. */
const CODE_MARK = /`[^`]*`/g;

/** A literal's text with its code marks taken out. A template's marks can open in one part and close
 *  in the next (`\`${id}\``), so they are read across the whole template, a value standing for each
 *  `${...}`, and only this part's share kept. */
function uncodedText(node: ts.Node & { text: string }): string {
  const template = ts.isTemplateHead(node)
    ? node.parent
    : ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ? node.parent.parent
      : undefined;
  if (!template || !ts.isTemplateExpression(template)) return node.text.replace(CODE_MARK, '');
  const parts = [template.head, ...template.templateSpans.map((s) => s.literal)];
  const kept = parts
    .map((p) => p.text)
    .join('\u0000')
    .replace(CODE_MARK, (mark) => mark.replace(/[^\u0000]/g, ''))
    .split('\u0000');
  return kept[parts.indexOf(node as (typeof parts)[number])] ?? '';
}

/** A query's text is code, whatever words its columns are named in. */
const isQuery = (node: ts.Node) =>
  ts.isTaggedTemplateExpression(node) && /^sql\b/.test(node.tag.getText());

function sourceFiles(path: string, file?: RegExp): string[] {
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return file ? [] : sourceFiles(full);
    if (
      !/\.ts$/.test(entry) ||
      /\.(test|fixture)\.ts$/.test(entry) ||
      /-reference\.ts$/.test(entry)
    )
      return [];
    return !file || file.test(entry) ? [full] : [];
  });
}

/** A logger's message goes to whoever operates Forge, never to the person who asked. */
const LOG_CALL = /\b(log|logger|console)\.(trace|debug|info|warn|error|fatal|log)$/;

function inLogCall(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isCallExpression(at) && LOG_CALL.test(at.expression.getText())) return true;
    if (ts.isFunctionLike(at)) return false;
  }
  return false;
}

/** A join hands a literal on; a comparison only reads it: `status === 'shipped'` says nothing. */
const JOINS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function joins(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && JOINS.has(node.operatorToken.kind);
}

/** What a bare literal is handed to once it has passed through a conditional or a join. */
function receiver(node: ts.Node): { at: ts.Node; from: ts.Node } {
  let from = node;
  let at = node.parent;
  while (ts.isConditionalExpression(at) || ts.isParenthesizedExpression(at) || joins(at)) {
    from = at;
    at = at.parent;
  }
  return { at, from };
}

/** Where a bare literal ends up: through a conditional or a join, into a template. */
function interpolated(node: ts.Node): boolean {
  return ts.isTemplateSpan(receiver(node).at);
}

/** The helpers that pick a sentence's word by number (`release-batch/counted.ts`). */
const WORDING = ['agree', 'counted', 'everyOne'];

/** `(one, many) => agree(n, one, many)`: a function whose whole body hands on to one of `names`. */
function handsOnTo(body: ts.Node, names: ReadonlySet<string>): boolean {
  let result: ts.Node | undefined = body;
  if (ts.isBlock(body)) {
    const [only] = body.statements;
    result =
      body.statements.length === 1 && only && ts.isReturnStatement(only)
        ? only.expression
        : undefined;
  }
  return (
    result !== undefined &&
    ts.isCallExpression(result) &&
    ts.isIdentifier(result.expression) &&
    names.has(result.expression.text)
  );
}

/** Every name in `source` a word is handed to: the counted helpers, and each local wrapper of one. */
function wordingHelpers(source: ts.SourceFile): Set<string> {
  const names = new Set(WORDING);
  const wrappers: Array<[string, ts.Node]> = [];
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      wrappers.push([node.name.text, node.body]);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      wrappers.push([node.name.text, node.initializer.body]);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of wrappers) {
      if (!names.has(name) && handsOnTo(body, names)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/** A literal handed to a wording helper is a word of the sentence it builds: `w('binding', 'bindings')`. */
function handedToWording(node: ts.Node, helpers: ReadonlySet<string>): boolean {
  const { at, from } = receiver(node);
  return (
    ts.isCallExpression(at) &&
    ts.isIdentifier(at.expression) &&
    helpers.has(at.expression.text) &&
    at.arguments.some((arg) => arg === from)
  );
}

/** A string a person can read: one holding a space or opening with a capital, or a word
 *  interpolated into one. An identifier, a code, a key, a column or a stored value is none. */
function isWords(node: ts.Node, text: string, helpers: ReadonlySet<string>): boolean {
  const parent = node.parent;
  if (
    ts.isLiteralTypeNode(parent) ||
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent)
  )
    return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node)
    return false;
  if (inLogCall(node)) return false;
  if (/\s/.test(text.trim()) || /^[A-Z]/.test(text)) return true;
  // A template's text between values is the sentence around them: ` (binding \u0024{id})`.
  if (
    (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
    /\s/.test(text)
  ) {
    return true;
  }
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    (interpolated(node) || handedToWording(node, helpers))
  );
}

/** Every readable string in `body` that says `word`, with its line; `uncoded` reads it with its
 *  code marks taken out. */
function wordsSaying(body: string, file: string, word: RegExp, uncoded = false): string[] {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const helpers = wordingHelpers(source);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (uncoded && isQuery(node)) return;
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    const said = literal && uncoded ? uncodedText(node) : literal ? node.text : '';
    if (literal && word.test(said) && isWords(node, node.text, helpers)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${line}: ${node.text.trim().replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hitsIn(surfaces: typeof SURFACES, word: RegExp, uncoded = false): string[] {
  const files = surfaces.flatMap(({ dir, file }) => sourceFiles(join(SRC, dir), file));
  expect(files.length).toBeGreaterThan(100);
  return files.flatMap((file) =>
    wordsSaying(readFileSync(file, 'utf8'), file, word, uncoded).map(
      (hit) => `${relative(SRC, file)}:${hit}`,
    ),
  );
}

describe("core's sentences to a person", () => {
  it('never say binding or bound', () => {
    expect(hitsIn(SURFACES, BINDING)).toEqual([]);
  });

  it('never say ship, outside a code mark naming a value a caller sends', () => {
    expect(hitsIn(RELEASE_SURFACES, SHIP, true)).toEqual([]);
  });

  it('finds ship in a sentence, a template and a wording helper, and not in a code mark, a value or a word that only holds it', () => {
    const planted = [
      "const a = 'closing it would claim a ship nobody wrote anything about.';",
      'const b = `The release finished and shipped \u0024{n} issues.`;',
      "const c = `\u0024{w('It does not', 'None of them')} ship\u0024{w('', 's')} without a decision.`;",
      "const d = 'Send `ship-unverified` with what is unverified.';",
      "const e = z.literal('ship-unverified');",
      "const f = 'The relationship and the membership stay.';",
      "const g = { holdsUntil: 'shipped' };",
      "const h = 'This project ships nothing.';",
      'const i = `decide \\`\u0024{id}\\` or \\`ship-unverified\\` instead`;',
      'const j = sql`SELECT released_at IS NOT NULL AS shipped FROM runs`;',
      'const k = `\\`\u0024{id}\\` shipped, or decide \\`ship-unverified\\``;',
      "const l = `\u0024{status === 'shipped' ? 'done' : 'open'}`;",
    ].join('\n');
    expect(wordsSaying(planted, 'planted.ts', SHIP, true).map((hit) => hit.split(': ')[0])).toEqual([
      '1',
      '2',
      '3',
      '8',
      '11',
    ]);
  });

  it('finds the word in a sentence, a template, an interpolated word and a word handed to a wording helper, and not in code or a log', () => {
    const planted = [
      "const a = 'This Coolify binding neither deploys to live.';",
      'const b = `This project has \u0024{n} Coolify bindings switched on.`;',
      "const c = `Take it off the \u0024{many ? 'bindings' : 'binding'} too.`;",
      "const d = 'no Rocket.Chat room is bound to this project';",
      "const e = { code: 'NOT_LIVE_BINDING', kind: 'binding' };",
      'const f = row.binding.id;',
      "log.warn({ bindingId }, 'decrypt failed for binding, skipping');",
      'const h = `\u0024{label} (binding \u0024{id})`;',
      'const g = api(`/integrations/\u0024{bindingId}/bindings`);',
      '// a binding named in a comment',
      'const w = (one: string, many: string) => agree(n, one, many);',
      "const i = `The live deploy \u0024{w('binding', 'bindings')} declares a verify`;",
      "const j = counted(n, 'binding');",
      "const k = `\u0024{row.get('binding')} and \u0024{w('target', 'targets')}`;",
      "function says(n: number) { return agree(n, 'its binding', 'their bindings'); }",
      "const l = says(n) + everyOne(n, 'binding');",
    ].join('\n');
    expect(wordsSaying(planted, 'planted.ts', BINDING).map((hit) => hit.split(': ')[0])).toEqual([
      '1',
      '2',
      '3',
      '3',
      '4',
      '8',
      '12',
      '12',
      '13',
      '15',
      '15',
      '16',
    ]);
  });
});
