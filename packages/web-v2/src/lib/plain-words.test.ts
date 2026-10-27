// Two words the store and the team use that a person reads otherwise. "Binding" is the store's word
// for a project's use of a connection, never shown on the Integrations tab (ISS-1421 r35, judge-141;
// r36 held "bound" and "Bind" and project settings too). "Ship" is the team's word for a release, and
// a person outside the team reads it as a boat (ISS-1421 r39, the master's ruling on judge-160): no
// sentence the web draws says it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");
const FEATURES = resolve(SRC, "features");
const BINDING_SURFACES = [resolve(FEATURES, "integrations"), resolve(FEATURES, "project-settings")];
const BINDING = /\b(bindings?|bound|bind|binds|unbind)\b/i;
const SHIP = /\bship(s|ped|ping)?\b/i;

/** What no person reads as the web's own sentence: a test's fixture, and the guides generated from
 *  the docs, which carry the docs' words. */
const NOT_DRAWN = /(^|\/)(test-support\/|[^/]*\.generated\.tsx?$)/;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** A join hands a literal on; a comparison only reads it: `decision === "ship-unverified"` says nothing. */
const JOINS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** Where a bare literal ends up: through a conditional or a join, into a template or JSX. */
function interpolated(node: ts.Node): boolean {
  let at = node.parent;
  while (
    ts.isConditionalExpression(at) ||
    ts.isParenthesizedExpression(at) ||
    (ts.isBinaryExpression(at) && JOINS.has(at.operatorToken.kind))
  )
    at = at.parent;
  return ts.isTemplateSpan(at) || ts.isJsxExpression(at);
}

/** Attributes whose value a person reads or hears: an accessible name, a title, a hint. */
const READ_ATTRIBUTES = /^(aria-label|aria-description|title|alt|placeholder|label|hint|summary|description|message|confirmLabel|cancelLabel|disabledReason)$/;

/** A string a person can read: JSX text, a readable attribute's value, a literal holding a space or
 *  opening with a capital, or a word interpolated into one. An identifier, a query key, a route or a
 *  stored value is none. A word reaching the screen through a variable is past this check's reach;
 *  the rendering tests of each component hold those. */
function isWords(node: ts.Node, text: string): boolean {
  if (ts.isJsxText(node)) return text.trim() !== "";
  const parent = node.parent;
  if (ts.isJsxAttribute(parent)) return READ_ATTRIBUTES.test(parent.name.getText());
  if (ts.isLiteralTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return false;
  if (/\s/.test(text.trim()) || /^[A-Z]/.test(text)) return true;
  // A template's text between values is the sentence around them: ` (binding \u0024{id})`.
  if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\s/.test(text)) {
    return true;
  }
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && interpolated(node);
}

/** Every readable string in `body` that says `word`, with its line. */
function wordsSaying(body: string, file: string, word: RegExp): string[] {
  const source = ts.createSourceFile(
    file,
    body,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (literal && word.test(node.text) && isWords(node, node.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${line}: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function hitsIn(surfaces: string[], word: RegExp): string[] {
  const files = surfaces.flatMap(sourceFiles).filter((file) => !NOT_DRAWN.test(relative(SRC, file)));
  expect(files.length).toBeGreaterThan(20);
  return files.flatMap((file) =>
    wordsSaying(readFileSync(file, "utf8"), file, word).map((hit) => `${relative(SRC, file)}:${hit}`),
  );
}

describe("the web's words", () => {
  it("never say binding, bound or bind to a person on the Integrations surface", () => {
    expect(hitsIn(BINDING_SURFACES, BINDING)).toEqual([]);
  });

  it("never say ship to a person anywhere", () => {
    expect(hitsIn([SRC], SHIP)).toEqual([]);
  });

  it("finds ship in a sentence, JSX text, a label and an interpolated word, and not in a value or a comparison", () => {
    const planted = [
      'const a = "This ships when a person cuts one.";',
      "const b = <span>— not shipped yet.</span>;",
      'const c = { value: "ship-unverified", label: "Ship unverified" };',
      'const d = <Tile label="Shipped · 30d" />;',
      'const e = `\u0024{n} shipped on \u0024{date}`;',
      'const f = decision === "ship-unverified" && <textarea />;',
      'const g: "settled" | "shipped" = "shipped";',
      'const h = <p>{done ? "shipped" : "open"}</p>;',
    ].join("\n");
    expect(wordsSaying(planted, "planted.tsx", SHIP).map((hit) => hit.split(": ")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "8",
    ]);
  });

  it("finds the word in a sentence, JSX text, an accessible name and an interpolated word, and not in code", () => {
    const planted = [
      'const a = "This Sentry binding is gone.";',
      "const b = `Delete its \u0024{n} project bindings?`;",
      "const c = <p>Binding settings</p>;",
      'const h = <button aria-label="binding" className="binding" />;',
      'const d = `Deletes it, with its \u0024{n > 1 ? "bindings" : "binding"}.`;',
      'const e: "binding" | "both" = "binding";',
      'const f = { queryKey: ["integration-connections", id, "bindings"] };',
      "const g = api(`/integration-connections/\u0024{id}/bindings`);",
      'const i = "no room is bound to this project";',
      "const j = `\u0024{label} (binding \u0024{id})`;",
      "// a binding named in a comment",
    ].join("\n");
    expect(wordsSaying(planted, "planted.tsx", BINDING).map((hit) => hit.split(": ")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "5",
      "9",
      "10",
    ]);
  });
});
