// ISS-1421 r35, judge-141: a gone row's drawer said "This Sentry binding is no longer on this
// project". "Binding" is the store's word for a project's use of a connection, and the Integrations
// tab never shows it to a person, so no sentence this feature draws may say it. The Release section
// beside it on project settings speaks to the same reader about the same rows.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FEATURES = resolve(__dirname, "..");
const SURFACES = [resolve(__dirname), resolve(FEATURES, "project-settings/components/release-section.tsx")];
const WORD = /\bbindings?\b/i;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Where a bare literal ends up: through a conditional or a join, into a template or JSX. */
function interpolated(node: ts.Node): boolean {
  let at = node.parent;
  while (ts.isConditionalExpression(at) || ts.isParenthesizedExpression(at) || ts.isBinaryExpression(at)) at = at.parent;
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
  return (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && interpolated(node);
}

/** Every readable string in `body` that says the word, with its line. */
function bindingWords(body: string, file: string): string[] {
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
    if (literal && WORD.test(node.text) && isWords(node, node.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${line}: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the Integrations surface's words", () => {
  it("never say binding to a person", () => {
    const hits = SURFACES.flatMap(sourceFiles).flatMap((file) =>
      bindingWords(readFileSync(file, "utf8"), file).map((hit) => `${relative(FEATURES, file)}:${hit}`),
    );
    expect(hits).toEqual([]);
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
      "// a binding named in a comment",
    ].join("\n");
    expect(bindingWords(planted, "planted.tsx").map((hit) => hit.split(": ")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "5",
    ]);
  });
});
