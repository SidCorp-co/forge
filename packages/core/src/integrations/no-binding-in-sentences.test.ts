// ISS-1421 r36, judge-145 on criterion 344: Confirm live deploy on a preview deploy target was
// refused "This Coolify binding neither deploys to live nor ...", and a turned-off Coolify drawer
// read "This project's Coolify binding answers nothing". "Binding" is the store's word for a
// project's use of a connection; the Integrations tab says connection or deploy target, and r35
// held the web to that. Every sentence core's integrations, landing and release code sends is held
// to it here, so a refusal a drawer shows cannot bring the word back.

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
];

const WORD = /\b(bindings?|bound|bind|binds|unbind)\b/i;

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

/** Where a bare literal ends up: through a conditional or a join, into a template. */
function interpolated(node: ts.Node): boolean {
  let at = node.parent;
  while (
    ts.isConditionalExpression(at) ||
    ts.isParenthesizedExpression(at) ||
    ts.isBinaryExpression(at)
  )
    at = at.parent;
  return ts.isTemplateSpan(at);
}

/** A string a person can read: one holding a space or opening with a capital, or a word
 *  interpolated into one. An identifier, a code, a key, a column or a stored value is none. */
function isWords(node: ts.Node, text: string): boolean {
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
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && interpolated(node)
  );
}

/** Every readable string in `body` that says the word, with its line. */
function bindingWords(body: string, file: string): string[] {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (literal && WORD.test(node.text) && isWords(node, node.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${line}: ${node.text.trim().replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("core's sentences to a person", () => {
  it('never say binding or bound', () => {
    const files = SURFACES.flatMap(({ dir, file }) => sourceFiles(join(SRC, dir), file));
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((file) =>
      bindingWords(readFileSync(file, 'utf8'), file).map((hit) => `${relative(SRC, file)}:${hit}`),
    );
    expect(hits).toEqual([]);
  });

  it('finds the word in a sentence, a template and an interpolated word, and not in code or a log', () => {
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
    ].join('\n');
    expect(bindingWords(planted, 'planted.ts').map((hit) => hit.split(': ')[0])).toEqual([
      '1',
      '2',
      '3',
      '3',
      '4',
      '8',
    ]);
  });
});
