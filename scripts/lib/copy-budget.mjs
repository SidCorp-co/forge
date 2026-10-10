// The copy budget (REQ-43 BC-1, BC-2, BC-4, BC-6, BC-11): every English string in the web copy files,
// and every English sentence core writes for a page, is short, an empty state is a word or two, and
// no string explains. Pure functions over already-read text, so a test can plant a string without a
// file.

import ts from 'typescript';

/** A `{name}` or `{{name}}` placeholder; it is one word whatever it expands to. */
const PLACEHOLDER = /\{\{[^}]*\}\}|\{[^}]*\}/g;

/** The words of one copy string: whitespace-separated tokens, each placeholder one word. */
export function wordsOf(text) {
  return text.replace(PLACEHOLDER, 'X').split(/\s+/).filter(Boolean).length;
}

/** Whether any dot-separated segment of `key` matches `segments` whole. */
export function keyHasSegment(key, segments) {
  return key.split('.').some((segment) => segments.test(segment));
}

/** Whether the last dot-separated segment of `key` — the one naming the string itself — matches `segments` whole. */
export function keyEndsWith(key, segments) {
  return segments.test(key.slice(key.lastIndexOf('.') + 1));
}

/**
 * What a key is, read from its segments by the conventions the config declares, never guessed from
 * the sentence: `explain` (a string that explains a section, a button or who can see something,
 * refused at any length), `empty` (an empty state), `refusal` (a refusal or confirmation) or `copy`.
 * An explanation or an empty state is named by the key's last segment, since a namespace segment
 * such as `help` in `common.help.title` names a page, not the string; a refusal by any segment,
 * since `x.refusal.moved` names its kind in the middle. Explaining wins over the rest, so a
 * `noneHint` is refused rather than budgeted as an empty state.
 */
export function kindOf(key, { refusalSegments, emptySegments, explainSegments }) {
  if (keyEndsWith(key, explainSegments)) return 'explain';
  if (keyEndsWith(key, emptySegments)) return 'empty';
  if (keyHasSegment(key, refusalSegments)) return 'refusal';
  return 'copy';
}

/** The words a key of `kind` may hold; an explaining string may hold none. */
function allowedFor(kind, { budget, refusalBudget, emptyBudget }) {
  if (kind === 'explain') return 0;
  if (kind === 'empty') return emptyBudget;
  if (kind === 'refusal') return refusalBudget;
  return budget;
}

/**
 * Every string of `entries` (`{file, key, text}`) the budget refuses, keyed `file::key`:
 * `{file, key, kind, words, budget}`. English only: a key's other languages are translations of it.
 * A blank string is no words, so it is never refused, whatever its kind.
 */
export function overBudget(entries, cfg) {
  const over = new Map();
  for (const { file, key, text } of entries) {
    const words = wordsOf(text);
    const kind = kindOf(key, cfg);
    const allowed = allowedFor(kind, cfg);
    if (words > allowed) over.set(`${file}::${key}`, { file, key, kind, words, budget: allowed });
  }
  return over;
}

/** One refusal line per string over budget, naming file, key, its words and what its kind allows. */
export function faults(over) {
  return [...over.values()]
    .sort((a, b) => `${a.file}::${a.key}`.localeCompare(`${b.file}::${b.key}`))
    .map((o) => {
      if (o.kind === 'explain')
        return `${o.file} · ${o.key}: a string that explains a section, a button or who can see something is refused at any length; delete it, or change the control`;
      const what =
        o.kind === 'empty'
          ? 'an empty state'
          : o.kind === 'refusal'
            ? 'a refusal or confirmation'
            : 'a copy string';
      return `${o.file} · ${o.key}: ${o.words} words, budget ${o.budget} for ${what}`;
    });
}

/**
 * The English sentences a registry of core's sentences declares (`export const <symbol> = { key: {
 * en: "…" }, … }`, as `packages/contracts/src/said-keys.ts` holds them), as `{file, key, text}`
 * entries. Read from the source's syntax, so nothing has to be built first. A registry this cannot
 * read whole throws naming the key and what is wrong, since a sentence skipped here is one the
 * budget never holds.
 */
export function sentencesOf(source, file, symbol) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let registry = null;
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations)
      if (ts.isIdentifier(decl.name) && decl.name.text === symbol) registry = decl.initializer;
  }
  while (registry && (ts.isSatisfiesExpression(registry) || ts.isAsExpression(registry)))
    registry = registry.expression;
  if (!registry || !ts.isObjectLiteralExpression(registry))
    throw new Error(
      `${file} declares no \`const ${symbol} = { … }\` object literal to read sentences from`,
    );
  const text = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const nameOf = (node) => (ts.isIdentifier(node) ? node.text : text(node));
  const entries = [];
  for (const prop of registry.properties) {
    const key = ts.isPropertyAssignment(prop)
      ? (nameOf(prop.name) ?? prop.name.getText(sf))
      : prop.getText(sf);
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer))
      throw new Error(
        `${file} · ${key}: an entry of ${symbol} must be \`{ en: "…" }\`, so its sentence can be read`,
      );
    const en = prop.initializer.properties.find(
      (q) => ts.isPropertyAssignment(q) && nameOf(q.name) === 'en',
    );
    const sentence = en ? text(en.initializer) : null;
    if (sentence === null)
      throw new Error(
        `${file} · ${key}: its \`en\` must be a string literal, so its sentence can be read`,
      );
    entries.push({ file, key, text: sentence });
  }
  if (entries.length === 0)
    throw new Error(
      `${file} · ${symbol} declares no sentence: the scan read nothing, which is not a pass`,
    );
  return entries;
}

/**
 * A plain word: two letters or more, an apostrophe allowed inside and punctuation around it. A token
 * with `.`, `/`, `_`, `@`, `:` or `-` inside is a URL, an address, a path, a key or a
 * format (`sat_…`, `you@studio.com`, `is:stuck`): data a person types or reads verbatim, not copy.
 */
const PLAIN_WORD = /^[("'“‘[]*[A-Za-z][A-Za-z'’]*[A-Za-z][)"'”’\].,;:!?…]*$/;

/** A copy key a value names (`issues.title`, `hintIssueStatus`): a reference to copy, not copy. */
const COPY_KEY = /^[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*|\.[A-Za-z0-9]+)+$/;

/** Whether `text` holds a plain word, so `·`, `—`, `&times;`, a key and a lone identifier are not copy. */
const readable = (text) =>
  !COPY_KEY.test(text) && text.split(/\s+/).some((token) => PLAIN_WORD.test(token));

/**
 * The person-facing English a source file writes inline (REQ-43 BC-1, BC-2): copy the budget cannot
 * read, because it sits in a `.tsx` or `.ts` file instead of a copy file. Four places, each read from
 * the source's syntax: JSX text between tags; a string literal given to an attribute `attributes`
 * matches whole (`title`, `placeholder`, `aria-label` and their kin); a string literal a JSX
 * expression renders, through `?:`, `??`, `||`, `&&` and parentheses — the `{x || "Document"}`
 * fallback; and an object property `attributes` names (`{ label: "Runs" }`, a nav entry or a sort
 * option a component renders later). A literal passed to a call (`t("issues.title")`, `cn("text-sm")`)
 * is an argument, not rendered copy, so it is never read, and a value naming a copy key is not copy.
 * Each is `{file, line, where, text}`, `where` naming the attribute, `<name>:` for a property, or
 * `text`.
 */
export function inlineCopyOf(source, file, attributes) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const add = (node, where, raw) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!readable(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    found.push({ file, line, where, text });
  };
  const rendered = (node, where) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return add(node, where, node.text);
    if (ts.isTemplateExpression(node))
      return add(node, where, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
    if (ts.isParenthesizedExpression(node)) return rendered(node.expression, where);
    if (ts.isConditionalExpression(node)) {
      rendered(node.whenTrue, where);
      return rendered(node.whenFalse, where);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        rendered(node.left, where);
        return rendered(node.right, where);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return rendered(node.right, where);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node, 'text', node.text);
    else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) rendered(node.expression, 'text');
    else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (attributes.test(name)) {
        const init = node.initializer;
        if (init && ts.isStringLiteral(init)) add(init, name, init.text);
        else if (init && ts.isJsxExpression(init)) rendered(init.expression, name);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(sf);
      if (attributes.test(name)) rendered(node.initializer, `${name}:`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** One refusal line per string a component writes inline, naming file, line, where and the words. */
export function inlineFaults(written) {
  return written.map((w) => {
    const what = w.where === 'text' ? 'JSX text' : w.where.endsWith(':') ? `property ${w.where}` : w.where;
    const words = w.text.length > 60 ? `${w.text.slice(0, 57)}…` : w.text;
    return `${w.file}:${w.line} · ${what} "${words}": copy written inline; move it to its feature's copy file, or delete it`;
  });
}
