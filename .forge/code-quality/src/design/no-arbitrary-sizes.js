import path from "node:path";
import { ALLOWLIST_OPTIONS } from "./allowlist.js";
import {
  DEFAULT_STYLESHEET_EXTENSIONS,
  isAllowedValue,
  keyName,
  lineOf,
  matchesFile,
  readSourceFiles,
} from "./tokens.js";

/**
 * Utility families whose arbitrary values duplicate a ramp step. Width is absent
 * on purpose: a table's min-width and a drawer's column are layout decisions no
 * token layer has an opinion on. `properties` names the same family where it is
 * written as a declaration rather than a utility — a style object or a stylesheet.
 */
export const DEFAULT_SIZE_FAMILIES = [
  {
    name: "font size",
    prefixes: ["text"],
    properties: ["fontSize", "font-size"],
    hint: "Use a step from the type ramp.",
  },
  {
    name: "radius",
    prefixes: [
      "rounded",
      "rounded-t",
      "rounded-r",
      "rounded-b",
      "rounded-l",
      "rounded-tl",
      "rounded-tr",
      "rounded-br",
      "rounded-bl",
      "rounded-s",
      "rounded-e",
      "rounded-ss",
      "rounded-se",
      "rounded-ee",
      "rounded-es",
    ],
    hint: "Use a radius step.",
  },
  { name: "line height", prefixes: ["leading"], hint: "Use a line-height step." },
  {
    name: "height",
    prefixes: ["h", "min-h", "max-h", "size"],
    hint: "Use a height token.",
  },
];

/** Padding on a plain box is layout; on a control the token layer has an answer. */
export const DEFAULT_INTERACTIVE_SIZE_FAMILIES = [
  {
    name: "padding",
    prefixes: ["p", "px", "py", "pt", "pb", "pl", "pr", "ps", "pe"],
    hint: "Use a control padding token.",
  },
];

export const DEFAULT_INTERACTIVE = {
  elements: [
    "a",
    "button",
    "input",
    "label",
    "select",
    "summary",
    "textarea",
    "Button",
    "Link",
  ],
  roles: ["button", "link", "menuitem", "option", "radio", "switch", "tab"],
  attributes: ["onClick"],
  classNames: ["cursor-pointer"],
};

export const DEFAULT_SIZE_UNITS = ["px", "rem", "em", "%", "vh", "vw", "ch", "pt"];

const patterns = new Map();

/**
 * A bracketed bare number. A value naming `var()` or `calc()` reaches a token,
 * which is the point of the scale, so it can never match.
 */
function familyPattern(prefix, units) {
  const key = `${prefix}::${units.join(",")}`;
  const cached = patterns.get(key);
  if (cached) return cached;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = escape(prefix);
  const suffixes = units.map(escape).join("|");
  const pattern = new RegExp(
    `(?:^|[\\s"'\`:}])(${escaped}-\\[-?\\d[\\d.]*(?:${suffixes})?\\])`,
    "g",
  );
  patterns.set(key, pattern);
  return pattern;
}

/**
 * A declared value that forks the scale: a bare number, with or without a unit.
 * `var()` and `calc()` reach a token, and a keyword like `inherit` names no size.
 */
function isArbitrarySizeValue(value, units) {
  if (typeof value === "number") return Number.isFinite(value);
  const text = String(value).trim().toLowerCase();
  if (text.includes("var(") || text.includes("calc(")) return false;
  const suffixes = units.map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^-?\\d[\\d.]*(?:${suffixes})?$`).test(text);
}

const familySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    prefixes: { type: "array", items: { type: "string" }, minItems: 1 },
    properties: { type: "array", items: { type: "string" } },
    hint: { type: "string" },
  },
  required: ["name", "prefixes"],
  additionalProperties: false,
};

function elementNames(element) {
  const name = element.name;
  if (name.type === "JSXIdentifier") return [name.name];
  if (name.type === "JSXMemberExpression") {
    return [name.property.name, `${name.object.name ?? ""}.${name.property.name}`];
  }
  return [];
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Reject arbitrary size values that fork the design scale",
      recommended: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          everywhere: { type: "array", items: familySchema },
          onInteractive: { type: "array", items: familySchema },
          interactive: {
            type: "object",
            properties: {
              elements: { type: "array", items: { type: "string" } },
              roles: { type: "array", items: { type: "string" } },
              attributes: { type: "array", items: { type: "string" } },
              classNames: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
          units: { type: "array", items: { type: "string" } },
          ...ALLOWLIST_OPTIONS,
        },
        additionalProperties: false,
      },
    ],
    messages: {
      arbitrarySize: '"{{value}}" is an arbitrary {{family}} value. {{remedy}}',
    },
  },
  create(context) {
    const {
      everywhere = DEFAULT_SIZE_FAMILIES,
      onInteractive = DEFAULT_INTERACTIVE_SIZE_FAMILIES,
      interactive = {},
      units = DEFAULT_SIZE_UNITS,
      allow = [],
      exemptFiles = [],
      tokenSource = null,
    } = context.options[0] ?? {};

    const filename = context.filename;
    if (matchesFile(filename, exemptFiles)) return {};

    const { sourceCode } = context;
    const control = { ...DEFAULT_INTERACTIVE, ...interactive };
    const scale = tokenSource ? ` The scale lives in ${tokenSource}.` : "";
    const interactivity = new Map();

    function isInteractive(element) {
      if (element === null) return false;
      const known = interactivity.get(element);
      if (known !== undefined) return known;
      const verdict =
        elementNames(element).some((name) => control.elements.includes(name)) ||
        element.attributes.some(
          (attribute) =>
            attribute.type === "JSXAttribute" &&
            (control.attributes.includes(attribute.name.name) ||
              (attribute.name.name === "role" &&
                attribute.value?.type === "Literal" &&
                control.roles.includes(attribute.value.value))),
        ) ||
        control.classNames.some((name) => sourceCode.getText(element).includes(name));
      interactivity.set(element, verdict);
      return verdict;
    }

    function enclosingElement(node) {
      const ancestors = sourceCode.getAncestors(node);
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        if (ancestors[index].type === "JSXOpeningElement") return ancestors[index];
      }
      return null;
    }

    function reportFamilies(node, text, families) {
      for (const family of families) {
        for (const prefix of family.prefixes) {
          const pattern = familyPattern(prefix, units);
          pattern.lastIndex = 0;
          for (const match of text.matchAll(pattern)) {
            const value = match[1];
            if (isAllowedValue(allow, filename, value)) continue;
            const start = node.range[0] + match.index + (match[0].length - value.length);
            context.report({
              loc: {
                start: sourceCode.getLocFromIndex(start),
                end: sourceCode.getLocFromIndex(start + value.length),
              },
              messageId: "arbitrarySize",
              data: {
                value,
                family: family.name,
                remedy: `${family.hint ?? "Use a step from the scale."}${scale}`,
              },
            });
          }
        }
      }
    }

    function scan(node) {
      const text = sourceCode.getText(node);
      reportFamilies(node, text, everywhere);
      if (onInteractive.length > 0 && isInteractive(enclosingElement(node))) {
        reportFamilies(node, text, onInteractive);
      }
    }

    // The same families written as a declaration: `style={{ fontSize: 13 }}` and
    // `fontSize="13"` never pass through a class string, so no utility scan sees them.
    const declared = new Map(
      [...everywhere, ...onInteractive].flatMap((family) =>
        (family.properties ?? []).map((property) => [property, family]),
      ),
    );

    function scanDeclaration(name, valueNode) {
      const family = name === null ? undefined : declared.get(name);
      if (family === undefined || valueNode?.type !== "Literal") return;
      const { value } = valueNode;
      if (typeof value !== "string" && typeof value !== "number") return;
      if (!isArbitrarySizeValue(value, units)) return;
      if (isAllowedValue(allow, filename, String(value))) return;
      context.report({
        node: valueNode,
        messageId: "arbitrarySize",
        data: {
          value: String(value),
          family: family.name,
          remedy: `${family.hint ?? "Use a step from the scale."}${scale}`,
        },
      });
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") scan(node);
      },
      TemplateElement(node) {
        scan(node);
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
 * The same ban over stylesheets, which ESLint parses without a CSS language
 * plugin no more for sizes than for colours — see the gate's `--design-tokens=`.
 */
export function findArbitrarySizesInFiles({
  roots = ["."],
  extensions = DEFAULT_STYLESHEET_EXTENSIONS,
  exemptFiles = [],
  allow = [],
  families = DEFAULT_SIZE_FAMILIES,
  units = DEFAULT_SIZE_UNITS,
  ignoredDirectories,
} = {}) {
  const violations = [];
  for (const [file, text] of readSourceFiles({ roots, extensions, exemptFiles, ignoredDirectories })) {
    for (const family of families) {
      for (const property of family.properties ?? []) {
        // Anchored on a declaration boundary, so `--font-size: 12px` in the token
        // layer is a token being declared rather than a size being written.
        const pattern = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}\\n]+)`, "gi");
        for (const match of text.matchAll(pattern)) {
          const value = match[1].trim();
          if (!isArbitrarySizeValue(value, units)) continue;
          if (isAllowedValue(allow, file, value)) continue;
          violations.push({
            file: path.relative(process.cwd(), file) || file,
            line: lineOf(text, match.index),
            family: family.name,
            value,
            hint: family.hint ?? "Use a step from the scale.",
          });
        }
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
