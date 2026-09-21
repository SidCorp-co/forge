import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DESIGN_SYSTEM } from "../inline-warning.js";
import { matchesFile } from "./tokens.js";
import { RAW_ELEMENT_WAIVER } from "../line-metrics.js";

/**
 * A design system is only a system where product code cannot reach past it. The primitive
 * carries the focus ring, the field metrics and the ramp step; the raw element carries the
 * browser's defaults, which is why a styled label over an OS chevron is the shape this
 * always takes. Every message names the primitive that owns the behaviour being lost.
 */
export const DEFAULT_PRIMITIVES = {
  button: { primitive: "Button", owns: "the focus ring and the disabled semantics" },
  select: {
    primitive: "Select",
    owns: "the field metrics and a chevron, the OS one being unrestylable",
  },
  input: {
    primitive: "Input",
    owns: "the field metrics and the aria-invalid wiring",
    // Neither is a control a primitive can own: one is never rendered, the other is
    // the OS file picker, whose button no stylesheet reaches.
    exceptTypes: ["hidden", "file"],
  },
  textarea: { primitive: "Textarea", owns: "the field metrics and the resize affordance" },
  h1: { primitive: "PageHeader", owns: "the page title's ramp step, and the one h1 a screen gets" },
  h2: { primitive: "CardTitle", owns: "the heading ramp step" },
  h3: { primitive: "CardTitle", owns: "the heading ramp step" },
  h4: { primitive: "CardTitle", owns: "the heading ramp step" },
};

const HEADING = /^h[1-6]$/;

/** The reason is mandatory, matching `inline-warning: none —`: a bare marker waives nothing. */
const WAIVER = RAW_ELEMENT_WAIVER;

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

// `export { A, B as C }`, `export function A`, `export const A`, `export class A`.
const EXPORT_LIST = /export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g;
const EXPORT_NAMED = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;

// A star barrel names nothing itself, so the module it re-exports is where the names are.
const EXPORT_STAR = /export\s+\*\s+from\s*["']([^"']+)["']/g;

const exportCache = new Map();

/** The file a source path means: itself, itself plus an extension, or its index. */
function moduleFile(source) {
  const found = EXTENSIONS.map((extension) => `${source}${extension}`).find(
    (candidate) => existsSync(candidate) && !candidate.endsWith(path.sep),
  );
  if (found !== undefined && !INDEX_FILES.some((name) => found.endsWith(name))) {
    const index = INDEX_FILES.map((name) => path.join(found, name)).find((file) => existsSync(file));
    if (index !== undefined) return index;
  }
  return found;
}

/** The names one file exports, star re-exports aside. Text, so the linted file needs no read. */
export function exportedNames(text, names = new Set()) {
  for (const match of text.matchAll(EXPORT_LIST)) {
    for (const entry of match[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim();
      if (name) names.add(name);
    }
  }
  for (const match of text.matchAll(EXPORT_NAMED)) names.add(match[1]);
  return names;
}

function collect(file, names, seen) {
  if (file === undefined || seen.has(file)) return;
  seen.add(file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }

  exportedNames(text, names);
  for (const match of text.matchAll(EXPORT_STAR)) {
    if (match[1].startsWith(".")) collect(moduleFile(path.resolve(path.dirname(file), match[1])), names, seen);
  }
}

/**
 * What the design system actually exports. A project whose system has no Textarea has
 * nothing to point a report at, so the element it writes instead is not yet a finding.
 * `null` means the source could not be read, and every element reports as before.
 */
export function primitiveExports(source) {
  const resolved = path.resolve(source);
  const cached = exportCache.get(resolved);
  if (cached !== undefined) return cached;

  const file = moduleFile(resolved);
  const names = new Set();
  collect(file, names, new Set());
  // A source naming nothing is a path that resolved to no module, or to one this scan
  // cannot read: reporting every element beats passing every element in silence.
  const found = names.size > 0 ? names : null;
  exportCache.set(resolved, found);
  return found;
}

const entrySchema = {
  type: "object",
  properties: {
    primitive: { type: "string", minLength: 1 },
    owns: { type: "string", minLength: 1 },
    exceptTypes: { type: "array", items: { type: "string" } },
  },
  required: ["primitive", "owns"],
  additionalProperties: false,
};

function attribute(node, name) {
  return node.attributes.find(
    (candidate) => candidate.type === "JSXAttribute" && candidate.name.name === name,
  );
}

function stringAttribute(node, attributeName) {
  const found = attribute(node, attributeName)?.value;
  if (found?.type === "Literal" && typeof found.value === "string") return found.value;
  if (found?.type === "JSXExpressionContainer" && found.expression.type === "Literal") {
    return typeof found.expression.value === "string" ? found.expression.value : null;
  }
  return null;
}

function name(node) {
  return node.name.type === "JSXIdentifier" ? node.name.name : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Reject raw elements the design system already owns a primitive for",
      recommended: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          primitives: { type: "object", additionalProperties: entrySchema },
          source: { type: "string" },
          importPath: { type: "string" },
          rampClasses: { type: "array", items: { type: "string" } },
          systemVariants: { type: "boolean" },
          exemptFiles: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawElement:
        "Raw <{{element}}> duplicates {{primitive}}{{from}}, which owns {{owns}}. {{remedy}}",
      systemVariant:
        "Raw <{{element}}> inside the design system, in a file that does not define " +
        "{{primitive}}. Add the variant to {{primitive}} and compose it here, rather than a " +
        "second <{{element}}> carrying its own copy of {{owns}}. {{remedy}}",
      missingPrimitive:
        "This config names {{primitive}} for <{{element}}>, and {{from}} does not export it. " +
        "Export it or drop the entry: until then no <{{element}}> anywhere is judged.",
    },
  },
  create(context) {
    const {
      primitives = DEFAULT_PRIMITIVES,
      source = null,
      importPath = null,
      rampClasses = [],
      systemVariants = true,
      exemptFiles = [],
    } = context.options[0] ?? {};

    const filename = context.filename;
    const relative = path.relative(process.cwd(), filename).split(path.sep).join("/");
    if (matchesFile(relative, exemptFiles)) return {};

    // Inside the system the element is judged against the file rather than skipped with the
    // directory: only the file exporting the primitive may render it. A second raw <button>
    // beside Button is a variant that was never added to it. `systemVariants: false` skips the
    // system wholesale instead, for a project adopting the rule over its screens first.
    const inSystem =
      DESIGN_SYSTEM.test(path.dirname(relative)) ||
      (source !== null && !path.relative(path.resolve(source), filename).startsWith(".."));
    if (inSystem && !systemVariants) return {};

    const configured = (context.options[0] ?? {}).primitives !== undefined;
    const exported = source ? primitiveExports(source) : null;
    const from = importPath ?? source;
    const { sourceCode } = context;
    const defined = inSystem ? exportedNames(sourceCode.getText()) : new Set();

    const waivers = sourceCode
      .getAllComments()
      .map((comment) => ({ end: comment.range[1], match: WAIVER.exec(comment.value) }))
      .filter((entry) => entry.match !== null);

    function waived(node) {
      const found = waivers.filter((entry) => !entry.used && entry.end < node.range[0]).pop();
      if (found === undefined) return false;
      found.used = true;
      return true;
    }

    return {
      JSXOpeningElement(node) {
        const element = name(node);
        const owner = element === null ? undefined : primitives[element];
        if (owner === undefined) return;

        const type = stringAttribute(node, "type");
        if (type !== null && (owner.exceptTypes ?? []).includes(type)) return;

        // A heading carrying a ramp class is a section that owns its own heading, which
        // is not a card: the ramp step is the thing the primitive was there to supply.
        if (HEADING.test(element) && rampClasses.length > 0) {
          const className = stringAttribute(node, "className") ?? "";
          if (rampClasses.some((prefix) => className.includes(prefix))) return;
        }

        // The file exporting the primitive is the one place the element it owns belongs.
        if (defined.has(owner.primitive)) return;
        if (waived(node)) return;

        // A default entry naming a primitive the barrel lacks is a project that has no such
        // primitive, and there is nothing to compose. A configured one is this project's own
        // claim about its own barrel, and a claim that stopped holding is the finding —
        // skipping it retires the rule for that element with nothing said.
        if (exported !== null && !exported.has(owner.primitive)) {
          if (!configured) return;
          context.report({
            node,
            messageId: "missingPrimitive",
            data: { element, primitive: owner.primitive, from: from ?? "the design system" },
          });
          return;
        }

        context.report({
          node,
          messageId: inSystem ? "systemVariant" : "rawElement",
          data: {
            element,
            primitive: owner.primitive,
            from: from ? ` from ${from}` : "",
            owns: owner.owns,
            remedy: `Compose ${owner.primitive}.`,
          },
        });
      },
    };
  },
};
