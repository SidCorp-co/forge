import path from "node:path";
import { ALLOWLIST_OPTIONS } from "./allowlist.js";
import {
  COLOR_PROPERTIES,
  DEFAULT_STYLESHEET_EXTENSIONS,
  findRawColors,
  isAllowedValue,
  isNamedColor,
  keyName,
  lineOf,
  matchesFile,
  NAMED_COLORS,
  NEUTRAL_COLOR_KEYWORDS,
  readSourceFiles,
} from "./tokens.js";

/**
 * Colour and size have separate homes, so `tokenSource` alone cannot name both: a project whose
 * scale file is the size scale sends every colour there. `colorSource` is the colour's own home
 * and falls back only where one file holds both. `colorReference` is how a project reads a token
 * back — `var(--…)` is CSS, and a client that renders without CSS never writes it.
 */
function remedyFor(colorSource, colorReference) {
  const home = colorSource ? `to ${colorSource}` : "to the token layer";
  const read = colorReference
    ? `read it through ${colorReference}`
    : "reference the token with var(--…)";
  return `Add the colour ${home} and ${read}.`;
}

/**
 * A `#…` naming a DOM id or a URL fragment is hex-shaped and is not a colour.
 * The text cannot tell `"#face"` from a colour; these positions can, and they
 * are the ones a string beginning with `#` is normally written for.
 */
const FRAGMENT_CALLS = new Set([
  "closest",
  "getElementById",
  "matches",
  "querySelector",
  "querySelectorAll",
]);
const FRAGMENT_ATTRIBUTES = new Set(["href", "htmlFor", "id", "to", "xlinkHref"]);

function namesSomethingElse(node) {
  const parent = node.parent;
  if (parent?.type === "JSXAttribute") return FRAGMENT_ATTRIBUTES.has(keyName(parent.name));
  if (parent?.type === "JSXExpressionContainer" && parent.parent?.type === "JSXAttribute") {
    return FRAGMENT_ATTRIBUTES.has(keyName(parent.parent.name));
  }
  if (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
    const callee = parent.callee;
    return FRAGMENT_CALLS.has(
      keyName(callee.type === "MemberExpression" ? callee.property : callee),
    );
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Reject raw colour values outside the design-token layer",
      recommended: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          ...ALLOWLIST_OPTIONS,
          colorProperties: { type: "array", items: { type: "string" } },
          colorReference: { type: "string" },
          colorSource: { type: "string" },
          namedColors: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawColor: 'Raw colour outside the token layer: {{kind}} "{{value}}". {{remedy}}',
    },
  },
  create(context) {
    const {
      allow = [],
      colorProperties = COLOR_PROPERTIES,
      colorReference = null,
      colorSource = null,
      exemptFiles = [],
      namedColors = NAMED_COLORS,
      tokenSource = null,
    } = context.options[0] ?? {};

    const filename = context.filename;
    if (matchesFile(filename, exemptFiles)) return {};

    const { sourceCode } = context;
    const remedy = remedyFor(colorSource ?? tokenSource, colorReference);
    const properties = new Set(colorProperties);

    function report(node, index, length, kind, value) {
      const start = node.range[0] + index;
      context.report({
        loc: {
          start: sourceCode.getLocFromIndex(start),
          end: sourceCode.getLocFromIndex(start + length),
        },
        messageId: "rawColor",
        data: { kind, value, remedy },
      });
    }

    // Hex, colour functions and Tailwind arbitrary values are literal text
    // wherever they sit, so every string and template chunk is scanned.
    function scanText(node) {
      const text = sourceCode.getText(node);
      for (const finding of findRawColors(text, { colorProperties, namedColors })) {
        if (isAllowedValue(allow, filename, finding.value)) continue;
        report(node, finding.index, finding.length, finding.kind, finding.value);
      }
    }

    // A colour name is only a colour beside a declaration that takes one, and in
    // an object or a JSX attribute that pairing lives in the tree, not the text.
    function scanDeclaration(name, valueNode) {
      if (name === null || !properties.has(name)) return;
      if (valueNode?.type !== "Literal" || typeof valueNode.value !== "string") return;
      const value = valueNode.value.trim();
      if (NEUTRAL_COLOR_KEYWORDS.includes(value.toLowerCase())) return;
      if (!isNamedColor(value, namedColors)) return;
      if (isAllowedValue(allow, filename, value)) return;
      report(valueNode, 0, sourceCode.getText(valueNode).length, "named CSS colour", value);
    }

    return {
      Literal(node) {
        if (typeof node.value === "string" && !namesSomethingElse(node)) scanText(node);
      },
      TemplateElement(node) {
        scanText(node);
      },
      Property(node) {
        scanDeclaration(keyName(node.key), node.value);
      },
      JSXAttribute(node) {
        scanDeclaration(keyName(node.name), node.value);
      },
    };
  },
};

/**
 * The same ban over stylesheets. ESLint parses no CSS without a language plugin,
 * and this plugin ships none, so the `.css` half of the ban is a text scan a
 * caller runs itself — see the gate's `--design-tokens=` config.
 */
export function findRawColorsInFiles({
  roots = ["."],
  extensions = DEFAULT_STYLESHEET_EXTENSIONS,
  exemptFiles = [],
  allow = [],
  colorProperties = COLOR_PROPERTIES,
  namedColors = NAMED_COLORS,
  ignoredDirectories,
} = {}) {
  const violations = [];
  for (const [file, text] of readSourceFiles({ roots, extensions, exemptFiles, ignoredDirectories })) {
    for (const finding of findRawColors(text, { colorProperties, namedColors })) {
      if (isAllowedValue(allow, file, finding.value)) continue;
      violations.push({
        file: path.relative(process.cwd(), file) || file,
        line: lineOf(text, finding.index),
        kind: finding.kind,
        value: finding.value,
      });
    }
  }
  return violations;
}
